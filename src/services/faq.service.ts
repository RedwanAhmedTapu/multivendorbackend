// ==================== services/faq.service.ts ====================
import { PrismaClient } from '@prisma/client';
import type { CreateFaqDto, UpdateFaqDto, FaqQuery } from '../types/faq.types.ts';

const prisma = new PrismaClient();

export class FaqService {
  // Get all FAQs with filtering and pagination
  async getAllFaqs(query: FaqQuery) {
    const {
      category,
      isActive,
      search,
      page = 1,
      limit = 10
    } = query;

    const skip = (page - 1) * limit;
    const take = limit;

    // Build where clause
    const where: any = {};

    if (category) {
      where.category = category;
    }

    if (isActive !== undefined) {
      where.isActive = isActive === true ;
    }

    if (search) {
      where.OR = [
        { question: { contains: search, mode: 'insensitive' } },
        { answer: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } }
      ];
    }

    // Get total count and data
    const [total, faqs] = await Promise.all([
      prisma.faq.count({ where }),
      prisma.faq.findMany({
        where,
        skip,
        take,
        orderBy: [
          { orderIndex: 'asc' },
          { createdAt: 'desc' }
        ]
      })
    ]);

    return {
      faqs,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  // Get FAQ by ID
  async getFaqById(id: string) {
    const faq = await prisma.faq.findUnique({
      where: { id }
    });

    if (!faq) {
      throw new Error('FAQ not found');
    }

    return faq;
  }

  // Get FAQs by category
  async getFaqsByCategory(category: string) {
    return await prisma.faq.findMany({
      where: {
        category,
        isActive: true
      },
      orderBy: [
        { orderIndex: 'asc' },
        { createdAt: 'desc' }
      ]
    });
  }

  // Get all unique categories
  async getCategories() {
    const faqs = await prisma.faq.findMany({
      where: { isActive: true },
      select: { category: true },
      distinct: ['category']
    });

    return faqs.map(faq => faq.category);
  }

  // Create FAQ
  async createFaq(data: CreateFaqDto) {
    // Get the highest orderIndex to auto-increment
    const lastFaq = await prisma.faq.findFirst({
      where: { category: data.category },
      orderBy: { orderIndex: 'desc' }
    });

    const orderIndex = data.orderIndex ?? (lastFaq ? lastFaq.orderIndex + 1 : 0);

    return await prisma.faq.create({
      data: {
        ...data,
        orderIndex
      }
    });
  }

  // Update FAQ
  async updateFaq(id: string, data: UpdateFaqDto) {
    // Check if FAQ exists
    const existingFaq = await prisma.faq.findUnique({
      where: { id }
    });

    if (!existingFaq) {
      throw new Error('FAQ not found');
    }

    return await prisma.faq.update({
      where: { id },
      data
    });
  }

  // Delete FAQ
  async deleteFaq(id: string) {
    // Check if FAQ exists
    const existingFaq = await prisma.faq.findUnique({
      where: { id }
    });

    if (!existingFaq) {
      throw new Error('FAQ not found');
    }

    return await prisma.faq.delete({
      where: { id }
    });
  }

  // Bulk update order
  async updateFaqOrder(updates: { id: string; orderIndex: number }[]) {
    const promises = updates.map(({ id, orderIndex }) =>
      prisma.faq.update({
        where: { id },
        data: { orderIndex }
      })
    );

    return await Promise.all(promises);
  }

  // Toggle FAQ active status
  async toggleFaqStatus(id: string) {
    const faq = await prisma.faq.findUnique({
      where: { id }
    });

    if (!faq) {
      throw new Error('FAQ not found');
    }

    return await prisma.faq.update({
      where: { id },
      data: { isActive: !faq.isActive }
    });
  }
}
