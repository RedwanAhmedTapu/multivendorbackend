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
  }) {
    return prisma.slider.create({
      data: {
        title: data.title,
        subtitle: data.subtitle,
        description: data.description,
        imageUrl: data.imageUrl,
        link: data.link,
        buttonText: data.buttonText,
        buttonLink: data.buttonLink,
        type: data.type, // Ensure 'type' is provided in the input data
      },
    });
  }

  async findAll() {
    return prisma.slider.findMany({
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
        buttonLink: data.buttonLink,
        type: data.type, // Ensure 'type' is provided in the input data

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