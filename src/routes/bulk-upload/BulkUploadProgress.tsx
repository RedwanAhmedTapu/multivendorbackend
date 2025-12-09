// components/bulkupload/BulkUploadProgress.tsx
"use client";
import React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";

export interface BulkProductRow {
  id: string;
  name: string;
  status: 'draft' | 'processing' | 'success' | 'error';
  errors: Record<string, string>;
}

interface BulkUploadProgressProps {
  products: BulkProductRow[];
}

export function BulkUploadProgress({ products }: BulkUploadProgressProps) {
  const totalProducts = products.length;
  const successCount = products.filter(p => p.status === 'success').length;
  const errorCount = products.filter(p => p.status === 'error').length;
  const processingCount = products.filter(p => p.status === 'processing').length;
  const draftCount = products.filter(p => p.status === 'draft').length;

  const progress = totalProducts > 0 ? ((successCount + errorCount) / totalProducts) * 100 : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload Progress</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={progress} className="w-full" />
        
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span>Total Products:</span>
            <span className="font-medium">{totalProducts}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-green-600">Successful:</span>
            <span className="font-medium">{successCount}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-blue-600">Processing:</span>
            <span className="font-medium">{processingCount}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-red-600">Errors:</span>
            <span className="font-medium">{errorCount}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Draft:</span>
            <span className="font-medium">{draftCount}</span>
          </div>
        </div>

        {errorCount > 0 && (
          <div className="bg-red-50 border border-red-200 p-3 rounded-lg">
            <p className="text-red-800 text-sm">
              {errorCount} product(s) failed to upload. Check the errors and try again.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}