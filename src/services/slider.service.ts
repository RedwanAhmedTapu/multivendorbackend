import { PrismaClient, SliderType } from "@prisma/client";

const prisma = new PrismaClient();

export class SliderService {
  async create(data: {
    title?: string;
    subtitle?: string;
    description?: string;
    imageUrl: string;
    link?: string;
    buttonText?: string;
    buttonLink?: string;
    type: SliderType;
    vendorId?: number;
  }) {
    return prisma.slider.create({ data });
  }

  async findAll() {
    return prisma.slider.findMany({
      include: { vendor: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async findOne(id: string) {
    return prisma.slider.findUnique({
      where: { id },
      include: { vendor: true },
    });
  }

  async update(
    id: string,
    data: Partial<{
      title: string;
      subtitle: string;
      description: string;
      imageUrl: string;
      link: string;
      buttonText: string;
      buttonLink: string;
      type: SliderType;
      vendorId?: number;
    }>
  ) {
    return prisma.slider.update({
      where: { id },
      data,
    });
  }

  async remove(id: string) {
    return prisma.slider.delete({
      where: { id },
    });
  }
}
