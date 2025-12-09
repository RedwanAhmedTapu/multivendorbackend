// components/bulkupload/ProductsTable.tsx
import React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Attribute } from "@/types/type";
import { ProductTableRow } from "./ProductTableRow";
import { BulkUploadPagination } from "./BulkUploadPagination";
import { ProductShippingWarrantyInput, ProductVariantInput } from "@/types/product";

// Define the interface locally since we can't import from page
interface ExtendedBulkProductData {
  id: string;
  name: string;
  description: string;
  sku: string;
  price: number;
  stock: number;
  approvalStatus: 'PENDING' | 'ACTIVE' | 'REJECTED';
  variantGroupNo?: number;
  images: string[];
  videoUrl?: string;
  attributes: any[];
  variantInputs: ProductVariantInput[];
  shippingWarranty?: ProductShippingWarrantyInput;
  errors: Record<string, string>;
  status: 'draft' | 'processing' | 'success' | 'error';
}

interface ProductsTableProps {
  products: ExtendedBulkProductData[];
  categoryAttributes: Attribute[];
  totalProducts: number;
  currentPage: number;
  totalPages: number;
  onUpdateField: (productId: string, field: string, value: any) => void;
  onUpdateAttribute: (productId: string, attributeId: string, field: string, value: any) => void;
  onToggleAttributeForVariant: (productId: string, attributeId: string) => void;
  onUpdateImages: (productId: string, images: string[]) => void;
  onUpdateVideo: (productId: string, videoUrl: string | null) => void;
  onUpdateShippingWarranty: (productId: string, shippingWarranty: ProductShippingWarrantyInput | undefined) => void;
  onAddVariant: (productId: string) => void;
  onUpdateVariant: (productId: string, variantId: string, field: string, value: any) => void;
  onRemoveVariant: (productId: string, variantId: string) => void;
  onRemoveProduct: (productId: string) => void;
  onAddProduct: () => void;
  onQuickAddRows: (count: number) => void;
  onUploadAll: () => void;
  onPageChange: (page: number) => void;
  isLoading: boolean;
  vendorId?: string;
  userRole: "VENDOR" | "ADMIN";
}

export function ProductsTable({
  products,
  categoryAttributes,
  totalProducts,
  currentPage,
  totalPages,
  onUpdateField,
  onUpdateAttribute,
  onToggleAttributeForVariant,
  onUpdateImages,
  onUpdateVideo,
  onUpdateShippingWarranty,
  onAddVariant,
  onUpdateVariant,
  onRemoveVariant,
  onRemoveProduct,
  onAddProduct,
  onQuickAddRows,
  onUploadAll,
  onPageChange,
  isLoading,
  vendorId,
  userRole
}: ProductsTableProps) {
  // Get required and optional attributes
  const requiredAttributes = categoryAttributes.filter(attr => attr.isRequired);
  const optionalAttributes = categoryAttributes.filter(attr => !attr.isRequired);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Products ({totalProducts})</CardTitle>
            <p className="text-sm text-gray-600 mt-1">
              Page {currentPage} of {totalPages}
            </p>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <Button onClick={onAddProduct} variant="outline" size="sm">
              + Add Single Row
            </Button>
            <Button 
              onClick={onUploadAll} 
              disabled={isLoading || totalProducts === 0}
              className="bg-green-600 hover:bg-green-700"
              size="sm"
            >
              {isLoading ? "Uploading..." : `Upload All (${totalProducts})`}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {totalProducts === 0 ? (
            <div className="text-center py-8">
              <p className="text-gray-500">No products added yet. Click "Add Single Row" to get started.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-gray-50 border-b">
                      <th className="p-2 text-left text-xs font-semibold sticky left-0 bg-gray-50 z-10 min-w-[60px]">
                        #
                      </th>
                      <th className="p-2 text-left text-xs font-semibold min-w-[180px]">
                        Basic Info
                      </th>
                      
                      {/* Required Attributes */}
                      {requiredAttributes.length > 0 && (
                        <th className="p-2 text-left text-xs font-semibold bg-red-50 min-w-[200px]">
                          <div className="text-red-700">Required Attributes</div>
                          <div className="text-xs text-red-600 font-normal">
                            {requiredAttributes.length} required
                          </div>
                        </th>
                      )}
                      
                      {/* Optional Attributes */}
                      {optionalAttributes.length > 0 && (
                        <th className="p-2 text-left text-xs font-semibold bg-blue-50 min-w-[200px]">
                          <div className="text-blue-700">Optional Attributes</div>
                          <div className="text-xs text-blue-600 font-normal">
                            {optionalAttributes.length} optional
                          </div>
                        </th>
                      )}
                      
                      <th className="p-2 text-left text-xs font-semibold min-w-[120px]">
                        Media & Details
                      </th>
                      <th className="p-2 text-left text-xs font-semibold min-w-[100px]">
                        Variants
                      </th>
                      <th className="p-2 text-left text-xs font-semibold sticky right-0 bg-gray-50 min-w-[80px]">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((product, index) => (
                      <ProductTableRow
                        key={product.id}
                        index={index}
                        product={product}
                        categoryAttributes={categoryAttributes}
                        onUpdateField={onUpdateField}
                        onUpdateAttribute={onUpdateAttribute}
                        onToggleAttributeForVariant={onToggleAttributeForVariant}
                        onUpdateImages={onUpdateImages}
                        onUpdateVideo={onUpdateVideo}
                        onUpdateShippingWarranty={onUpdateShippingWarranty}
                        onAddVariant={onAddVariant}
                        onUpdateVariant={onUpdateVariant}
                        onRemoveVariant={onRemoveVariant}
                        onRemoveProduct={onRemoveProduct}
                        vendorId={vendorId}
                        userRole={userRole}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="mt-4">
                  <BulkUploadPagination
                    currentPage={currentPage}
                    totalPages={totalPages}
                    onPageChange={onPageChange}
                  />
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Quick Add Section */}
      {totalProducts > 0 && (
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
              <div>
                <h4 className="font-medium">Quick Add Multiple Rows</h4>
                <p className="text-sm text-gray-600">
                  Add multiple empty product rows at once (max 100 total)
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => onQuickAddRows(5)}
                  disabled={totalProducts >= 100}
                >
                  + 5 Rows
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => onQuickAddRows(10)}
                  disabled={totalProducts >= 100}
                >
                  + 10 Rows
                </Button>
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => onQuickAddRows(20)}
                  disabled={totalProducts >= 100}
                >
                  + 20 Rows
                </Button>
              </div>
            </div>
            {totalProducts >= 100 && (
              <p className="text-sm text-yellow-600 mt-2">
                Maximum limit of 100 products reached
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}