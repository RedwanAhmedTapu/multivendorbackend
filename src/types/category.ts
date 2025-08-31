// types/category.ts
export interface CreateCategoryInput {
  name: string;
  slug?: string;
  image?: string;
  parentId?: string;
}

export interface UpdateCategoryInput {
  name?: string;
  slug?: string;
  image?: string;
  parentId?: string | null;
}