// tests/review-images.test.ts
//
// Review photos: ownership, the three-image cap, gap-free position reuse,
// upload→row ordering with rollback on failure, and delete order.
//
// Stubs only: prisma is replaced method-by-method and the R2 uploader/remover are
// injected, so no bucket and no database are touched.
//   npx tsx --test tests/review-images.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../src/config/prisma.ts";
import {
  MAX_REVIEW_IMAGES,
  ReviewImageService,
  nextPosition,
  validateImageFile,
} from "../src/modules/product-module/services/product/review-image.service.ts";
import { ReviewImageController } from "../src/modules/product-module/controllers/review-image.controller.ts";

const p: any = prisma;

const file = (over: Record<string, unknown> = {}) => ({
  buffer: Buffer.from("fake-image"),
  originalname: "photo.jpg",
  mimetype: "image/jpeg",
  size: 1024,
  ...over,
});

function stubPrisma(options: {
  ownsReview?: boolean;
  positions?: number[];
  imageRow?: { id: string; url: string } | null;
  createThrows?: boolean;
}) {
  const calls: any[] = [];
  const originals = {
    findFirst: p.review.findFirst,
    findMany: p.reviewImage.findMany,
    create: p.reviewImage.create,
    imageFindFirst: p.reviewImage.findFirst,
    remove: p.reviewImage.delete,
  };

  p.review.findFirst = async (args: any) => {
    calls.push({ op: "review.findFirst", args });
    return options.ownsReview === false ? null : { id: "r1" };
  };
  p.reviewImage.findMany = async (args: any) => {
    calls.push({ op: "image.findMany", args });
    return (options.positions ?? []).map((position) => ({ position }));
  };
  p.reviewImage.create = async (args: any) => {
    calls.push({ op: "image.create", args });
    if (options.createThrows) throw new Error("insert failed");
    return { id: "img-new", url: args.data.url, position: args.data.position };
  };
  p.reviewImage.findFirst = async (args: any) => {
    calls.push({ op: "image.findFirst", args });
    return options.imageRow === undefined ? { id: "img-1", url: "https://cdn.test/reviews/r1/a.jpg" } : options.imageRow;
  };
  p.reviewImage.delete = async (args: any) => {
    calls.push({ op: "image.delete", args });
    return { id: args.where.id };
  };

  return {
    calls,
    restore() {
      p.review.findFirst = originals.findFirst;
      p.reviewImage.findMany = originals.findMany;
      p.reviewImage.create = originals.create;
      p.reviewImage.findFirst = originals.imageFindFirst;
      p.reviewImage.delete = originals.remove;
    },
  };
}

const fakeRes = () => {
  const res: any = { statusCode: 0, body: null };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
};

test("the cap is three, and positions fill the lowest free slot", () => {
  assert.equal(MAX_REVIEW_IMAGES, 3);
  assert.equal(nextPosition([]), 0);
  assert.equal(nextPosition([0]), 1);
  assert.equal(nextPosition([0, 2]), 1, "a deleted middle photo is reused");
  assert.equal(nextPosition([1, 2]), 0);
  assert.throws(() => nextPosition([0, 1, 2]), /at most 3 photos/);
});

test("file validation rejects missing, oversized and non-image uploads", () => {
  assert.throws(() => validateImageFile(undefined), /Image file is required/);
  assert.throws(() => validateImageFile({ size: 6 * 1024 * 1024, mimetype: "image/jpeg" }), /5MB/);
  assert.throws(() => validateImageFile({ size: 10, mimetype: "application/pdf" }), /Invalid file type/);
  assert.doesNotThrow(() => validateImageFile({ size: 10, mimetype: "image/webp" }));
});

test("another customer's review is a 404 and never uploads", async () => {
  const db = stubPrisma({ ownsReview: false });
  let uploaded = 0;
  try {
    await assert.rejects(
      () =>
        ReviewImageService.add("u-other", "r1", file(), {
          upload: async () => {
            uploaded += 1;
            return { url: "x", key: "k" };
          },
          remove: async () => {},
        }),
      /Review not found/
    );
    assert.equal(uploaded, 0);
    // Ownership is part of the lookup.
    assert.deepEqual(db.calls[0].args.where, { id: "r1", userId: "u-other" });
  } finally {
    db.restore();
  }
});

test("a fourth photo is refused before anything reaches storage", async () => {
  const db = stubPrisma({ positions: [0, 1, 2] });
  let uploaded = 0;
  try {
    await assert.rejects(
      () =>
        ReviewImageService.add("u1", "r1", file(), {
          upload: async () => {
            uploaded += 1;
            return { url: "x", key: "k" };
          },
          remove: async () => {},
        }),
      /at most 3 photos/
    );
    assert.equal(uploaded, 0, "no upload when the cap is already reached");
  } finally {
    db.restore();
  }
});

test("upload happens first, then the row is created in the free slot", async () => {
  const db = stubPrisma({ positions: [0] });
  const uploads: any[] = [];
  try {
    const image = await ReviewImageService.add("u1", "r1", file({ originalname: "front.png", mimetype: "image/png" }), {
      upload: async (args) => {
        uploads.push(args);
        return { url: "https://cdn.test/reviews/r1/new.png", key: "reviews/r1/new.png" };
      },
      remove: async () => {},
    });

    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].reviewId, "r1");
    assert.equal(uploads[0].contentType, "image/png");
    assert.equal(uploads[0].fileName, "front.png");

    const create = db.calls.find((c) => c.op === "image.create");
    assert.deepEqual(create.args.data, {
      reviewId: "r1",
      url: "https://cdn.test/reviews/r1/new.png",
      position: 1,
    });
    assert.deepEqual(image, { id: "img-new", url: "https://cdn.test/reviews/r1/new.png", position: 1 });
  } finally {
    db.restore();
  }
});

test("a failed insert removes the uploaded object again", async () => {
  const db = stubPrisma({ positions: [], createThrows: true });
  const removed: string[] = [];
  try {
    await assert.rejects(
      () =>
        ReviewImageService.add("u1", "r1", file(), {
          upload: async () => ({ url: "https://cdn.test/reviews/r1/x.jpg", key: "reviews/r1/x.jpg" }),
          remove: async (key) => {
            removed.push(key);
          },
        }),
      /insert failed/
    );
    assert.deepEqual(removed, ["reviews/r1/x.jpg"], "no orphan left in the bucket");
  } finally {
    db.restore();
  }
});

test("remove deletes the object, then the row", async () => {
  const db = stubPrisma({});
  const removed: string[] = [];
  try {
    const result = await ReviewImageService.remove("u1", "r1", "img-1", {
      upload: async () => ({ url: "x", key: "k" }),
      remove: async (key) => {
        removed.push(key);
      },
    });

    assert.deepEqual(removed, ["reviews/r1/a.jpg"], "storage first, from the stored URL");
    assert.deepEqual(result, { id: "img-1" });
    const order = db.calls.map((c) => c.op);
    assert.ok(order.indexOf("image.findFirst") < order.indexOf("image.delete"));
  } finally {
    db.restore();
  }
});

test("removing an image that does not belong to the review is a 404", async () => {
  const db = stubPrisma({ imageRow: null });
  try {
    await assert.rejects(
      () => ReviewImageService.remove("u1", "r1", "img-foreign", { upload: async () => ({ url: "x", key: "k" }), remove: async () => {} }),
      /Image not found/
    );
  } finally {
    db.restore();
  }
});

test("controller: unauthenticated is 401, and a successful upload returns 201", async () => {
  const originalAdd = ReviewImageService.add;
  let received: any = null;
  (ReviewImageService as any).add = async (userId: string, reviewId: string, payload: any) => {
    received = { userId, reviewId, name: payload.originalname, type: payload.mimetype };
    return { id: "img-new", url: "https://cdn.test/reviews/r1/a.jpg", position: 0 };
  };

  try {
    const anon = fakeRes();
    await ReviewImageController.upload({ user: undefined, params: { reviewId: "r1" } } as any, anon);
    assert.equal(anon.statusCode, 401);

    const res = fakeRes();
    await ReviewImageController.upload(
      {
        user: { rawId: "u1", role: "USER" },
        params: { reviewId: "r1" },
        file: { buffer: Buffer.from("x"), originalname: "a.jpg", mimetype: "image/jpeg", size: 10 },
      } as any,
      res
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.position, 0);
    // The controller passes the *session* user id, never a body/query value.
    assert.deepEqual(received, { userId: "u1", reviewId: "r1", name: "a.jpg", type: "image/jpeg" });
  } finally {
    (ReviewImageService as any).add = originalAdd;
  }
});
