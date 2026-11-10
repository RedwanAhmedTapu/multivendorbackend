// services/slider.service.ts
import { prisma } from "../config/prisma.ts";

export class SliderService {
  async create(data: {
    title?: string;
    subtitle?: string;
    description?: string;
    imageUrl: string;
    link?: string;
    buttonText?: string;
    buttonLink?: string;
    type: "HOMEPAGE" | "VENDORPAGE";
    vendorId?: string;
  }) {
    return prisma.slider.create({
      data: {
        title: data.title,
        subtitle: data.subtitle,
        description: data.description,
        imageUrl: data.imageUrl,
        link: data.link,
        buttonText: data.buttonText,
        // If admin picked a vendor but didn't type a custom link, send the
        // slide straight to that vendor's storefront on click.
        buttonLink: data.buttonLink || (data.vendorId ? `/store/${data.vendorId}` : undefined),
        type: data.type,
        vendorId: data.vendorId || undefined,
      },
    });
  }

  async findAll(filter?: { type?: "HOMEPAGE" | "VENDORPAGE"; vendorId?: string }) {
    return prisma.slider.findMany({
      where: {
        ...(filter?.type ? { type: filter.type } : {}),
        ...(filter?.vendorId ? { vendorId: filter.vendorId } : {}),
      },
      include: {
        vendor: { select: { id: true, storeName: true, avatar: true } },
      },
      orderBy: [
        { createdAt: 'desc' }
      ]
    });
  }

  async findOne(id: string) {
    return prisma.slider.findUnique({
      where: { id }
    });
  }

  async update(id: string, data: any) {
    return prisma.slider.update({
      where: { id },
      data: {
        title: data.title,
        subtitle: data.subtitle,
        description: data.description,
        imageUrl: data.imageUrl,
        link: data.link,
        buttonText: data.buttonText,
        buttonLink: data.buttonLink || (data.vendorId ? `/store/${data.vendorId}` : undefined),
        type: data.type,
        vendorId: data.vendorId || undefined,
      },
    });
  }

  async remove(id: string) {
    const slider = await prisma.slider.findUnique({
      where: { id }
    });

    if (!slider) {
      throw new Error('Slider not found');
    }

    await prisma.slider.delete({
      where: { id }
    });

    return slider; // Return slider data for image cleanup
  }
}