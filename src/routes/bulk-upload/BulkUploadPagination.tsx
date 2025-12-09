// components/bulkupload/BulkUploadPagination.tsx
import React from "react";
import { Button } from "@/components/ui/button";

interface BulkUploadPaginationProps {
  currentPage: number;
  totalPages: number;
  totalProducts: number;
  indexOfFirstProduct: number;
  indexOfLastProduct: number;
  onPageChange: (page: number) => void;
}

export function BulkUploadPagination({
  currentPage,
  totalPages,
  totalProducts,
  indexOfFirstProduct,
  indexOfLastProduct,
  onPageChange
}: BulkUploadPaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex justify-between items-center mt-6 pt-4 border-t">
      <div className="text-sm text-gray-600">
        Showing {indexOfFirstProduct + 1}-{Math.min(indexOfLastProduct, totalProducts)} of {totalProducts}
      </div>
      
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
        >
          Previous
        </Button>
        
        <div className="flex gap-1">
          {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
            let page;
            if (totalPages <= 5) {
              page = i + 1;
            } else if (currentPage <= 3) {
              page = i + 1;
            } else if (currentPage >= totalPages - 2) {
              page = totalPages - 4 + i;
            } else {
              page = currentPage - 2 + i;
            }
            
            return (
              <Button
                key={page}
                variant={currentPage === page ? "default" : "outline"}
                size="sm"
                onClick={() => onPageChange(page)}
                className="w-8 h-8 p-0"
              >
                {page}
              </Button>
            );
          })}
        </div>
        
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage === totalPages}
          onClick={() => onPageChange(currentPage + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}