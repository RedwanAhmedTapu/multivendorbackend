export interface MessagePayload {
  conversationId?: string;
  receiverId?: string;
  productId?: string;
  orderId?: number;
  content: string;
  type: 'PRODUCT_INQUIRY' | 'VENDOR_SUPPORT' | 'USER_SUPPORT' | 'DELIVERY_CHAT' | 'GENERAL_CHAT';
}

export interface CreateConversationPayload {
  participantIds: string[];
  participantTypes: ('CUSTOMER' | 'VENDOR' | 'ADMIN' | 'EMPLOYEE' | 'DELIVERY')[];
  productId?: string;
  orderId?: number;
  title?: string;
  type: ConversationType;
}

export interface SocketUser {
  userId: string;
  socketId: string;
  userType: 'CUSTOMER' | 'VENDOR' | 'ADMIN' | 'EMPLOYEE' | 'DELIVERY';
}

export type ConversationType = 'PRODUCT_INQUIRY' | 'VENDOR_SUPPORT' | 'USER_SUPPORT' | 'DELIVERY_CHAT' | 'GENERAL_CHAT';
export type ParticipantType = 'CUSTOMER' | 'VENDOR' | 'ADMIN' | 'EMPLOYEE' | 'DELIVERY';