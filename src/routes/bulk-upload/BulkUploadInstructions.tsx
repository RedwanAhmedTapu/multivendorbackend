// components/bulkupload/BulkUploadInstructions.tsx
import React from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ImageIcon, Video, FileText, Upload } from "lucide-react";

export function BulkUploadInstructions() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick Guide</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="space-y-2">
          <h4 className="font-semibold text-green-600">Table Columns</h4>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li><strong>Basic Info:</strong> Name, SKU, Price, Stock</li>
            <li><strong>Specifications:</strong> Enter values directly</li>
            <li><strong>Attributes:</strong> Select from dropdown</li>
            <li><strong>Icons:</strong> Click to manage images/video/description</li>
          </ul>
        </div>

        <div className="space-y-2">
          <h4 className="font-semibold text-blue-600">Variant Groups</h4>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li>Same number = variants of one product</li>
            <li>Leave empty for standalone products</li>
            <li>Variants share name, different attributes</li>
          </ul>
        </div>

        <div className="space-y-2">
          <h4 className="font-semibold text-purple-600">Icon Actions</h4>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li><ImageIcon className="inline h-3 w-3" /> Upload/manage images</li>
            <li><Video className="inline h-3 w-3" /> Add video URL</li>
            <li><FileText className="inline h-3 w-3" /> Edit description</li>
            <li><Upload className="inline h-3 w-3" /> Shipping info</li>
          </ul>
        </div>

        <div className="space-y-2">
          <h4 className="font-semibold text-orange-600">Tips</h4>
          <ul className="list-disc list-inside space-y-1 text-xs">
            <li>Green checkmark = data added</li>
            <li>Red errors must be fixed before upload</li>
            <li>Use "Quick Add" for multiple rows</li>
            <li>Table scrolls horizontally</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}