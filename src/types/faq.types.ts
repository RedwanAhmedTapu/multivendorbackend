// ==================== types/faq.types.ts ====================
export interface CreateFaqDto {
  category: string;
  question: string;
  answer: string;
  isActive: boolean;
  orderIndex?: number;
}

export interface UpdateFaqDto {
  category?: string;
  question?: string;
  answer?: string;
  isActive?: boolean;
  orderIndex?: number;
}

export interface FaqQuery {
  category?: string;
  isActive?: boolean;
  search?: string;
  page?: number;
  limit?: number;
}