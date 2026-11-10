// services/product/product-content-score.service.ts
import { prisma } from "../../../../config/prisma.ts";

function containsImageUrls(text: string): boolean {
  const imageExtensions = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"];
  const imagePatterns = [
    /https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg)/i,
    /<img[^>]+src=["'][^"']+["'][^>]*>/i,
    /!\[.*?\]\(.*?\)/,
  ];
  const lowerText = text.toLowerCase();
  if (imageExtensions.some((ext) => lowerText.includes(ext))) return true;
  return imagePatterns.some((pattern) => pattern.test(text));
}

/**
 * Vendor-facing "listing quality" score — flags products that are likely
 * to under-perform in search/conversion (too few images, thin
 * description) so a vendor can improve them before/after approval.
 * Kept separate from statistics services since it's content-quality
 * scoring, not a metric aggregate.
 */
export const VendorProductContentService = {
  async getSummary(vendorId: string) {
    const products = await prisma.product.findMany({
      where: { vendorId, isDeleted: false },
      select: {
        id: true,
        name: true,
        description: true,
        approvalStatus: true,
        images: { select: { url: true } },
      },
    });

    const summary = products.map((product) => {
      const mainImageCount = product.images.length;
      const hasEnoughMainImages = mainImageCount >= 3;
      const hasDescriptionImages = product.description ? containsImageUrls(product.description) : false;
      const isDescriptionTooShort = product.description ? product.description.trim().length < 150 : true;

      const issues: string[] = [];
      if (!hasEnoughMainImages) issues.push("Need more images");
      if (!hasDescriptionImages) issues.push("No images in description");
      if (isDescriptionTooShort) issues.push("Short description");

      return {
        productId: product.id,
        productName: product.name,
        status: product.approvalStatus,
        imageCount: mainImageCount,
        hasDescriptionImages,
        isDescriptionTooShort,
        issues,
        needsImprovement: issues.length > 0,
      };
    });

    const needsImprovement = summary.filter((item) => item.needsImprovement).length;

    return {
      totalProducts: summary.length,
      needsImprovement,
      improvementRate: summary.length ? Math.round((needsImprovement / summary.length) * 100) : 0,
      products: summary,
    };
  },
};
