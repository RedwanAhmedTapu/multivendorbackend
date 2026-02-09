// src/types/footerSettings.types.ts

export interface FooterElement {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  label: string;
  url: string;
  displayOrder: number;
  isVisible: boolean;
  openInNewTab: boolean;
  footerColumnId: string;
}

export interface FooterColumn {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  isVisible: boolean;
  footerSettingsId: string;
  elements: FooterElement[];
}

export interface FooterSettings {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  companyName: string;
  address: string;
  email: string;
  phone1: string;
  phone2?: string | null;
  dbidNumber: string;
  tradeLicense: string;
  newsletterTitle: string;
  newsletterDescription: string;
  socialMediaTitle: string;
  twitterUrl?: string | null;
  facebookUrl?: string | null;
  youtubeUrl?: string | null;
  instagramUrl?: string | null;
  whatsappUrl?: string | null;
  copyrightText: string;
  paymentBannerImage: string;
  isActive: boolean;
  columns: FooterColumn[];
}

// DTOs for creating/updating
export interface CreateFooterElementDto {
  label: string;
  url: string;
  displayOrder?: number;
  isVisible?: boolean;
  openInNewTab?: boolean;
}

export interface CreateFooterColumnDto {
  title: string;
  isVisible?: boolean;
  elements?: CreateFooterElementDto[];
}

export interface CreateFooterSettingsDto {
  companyName: string;
  address: string;
  email: string;
  phone1: string;
  phone2?: string;
  dbidNumber: string;
  tradeLicense: string;
  newsletterTitle: string;
  newsletterDescription: string;
  socialMediaTitle: string;
  twitterUrl?: string;
  facebookUrl?: string;
  youtubeUrl?: string;
  instagramUrl?: string;
  whatsappUrl?: string;
  copyrightText: string;
  paymentBannerImage: string;
  columns?: CreateFooterColumnDto[];
}

export interface UpdateFooterSettingsDto extends Partial<CreateFooterSettingsDto> {}

export interface UpdateFooterColumnDto {
  title?: string;
  isVisible?: boolean;
}

export interface UpdateFooterElementDto {
  label?: string;
  url?: string;
  displayOrder?: number;
  isVisible?: boolean;
  openInNewTab?: boolean;
}