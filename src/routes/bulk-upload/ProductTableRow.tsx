// components/bulkupload/ProductTableRow.tsx
import React, { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import type { Attribute } from "@/types/type";
import { ProductShippingWarrantyInput, ProductVariantInput } from "@/types/product";
import ProductDescriptionEditor from "@/components/productdescription/ProductDescriptionl";
import ShippingWarrantyForm from "@/components/product/vendor/productform/ShippingWarrantyForm";
import { 
  ImageIcon, 
  Video, 
  FileText, 
  Trash2, 
  Package,
  Plus,
  Edit,
  Eye,
  X,
  AlertCircle,
  CheckCircle,
  Clock,
  AlertTriangle
} from "lucide-react";
import ImageUploader from "@/components/imageuploader/ImageUploader";
import VideoUploader from "@/components/videouploader/VideoUploader";

// Define the interface locally
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

interface ProductTableRowProps {
  index: number;
  product: ExtendedBulkProductData;
  categoryAttributes: Attribute[];
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
  vendorId?: string;
  userRole: "VENDOR" | "ADMIN";
}

export function ProductTableRow({ 
  index,
  product, 
  categoryAttributes, 
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
  vendorId,
  userRole
}: ProductTableRowProps) {
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [videoDialogOpen, setVideoDialogOpen] = useState(false);
  const [descriptionDialogOpen, setDescriptionDialogOpen] = useState(false);
  const [shippingDialogOpen, setShippingDialogOpen] = useState(false);
  const [variantsDialogOpen, setVariantsDialogOpen] = useState(false);

  const statusConfig = {
    draft: { 
      color: 'bg-gray-300', 
      text: 'text-gray-700',
      icon: <Clock className="h-3 w-3" />,
      label: 'Draft'
    },
    processing: { 
      color: 'bg-blue-500', 
      text: 'text-blue-700',
      icon: <Clock className="h-3 w-3 animate-spin" />,
      label: 'Processing'
    },
    success: { 
      color: 'bg-green-500', 
      text: 'text-green-700',
      icon: <CheckCircle className="h-3 w-3" />,
      label: 'Success'
    },
    error: { 
      color: 'bg-red-500', 
      text: 'text-red-700',
      icon: <AlertTriangle className="h-3 w-3" />,
      label: 'Error'
    }
  };

  const status = statusConfig[product.status];

  // Get product attribute by ID
  const getProductAttribute = (attributeId: string) => {
    return product.attributes.find(attr => attr.attributeId === attributeId);
  };

  // Get category attribute by ID
  const getCategoryAttribute = (attributeId: string) => {
    return categoryAttributes.find(attr => attr.id === attributeId);
  };

  // Render attribute input based on type
  const renderAttributeInput = (attributeId: string, isRequired: boolean = false) => {
    const productAttr = getProductAttribute(attributeId);
    const categoryAttr = getCategoryAttribute(attributeId);
    
    if (!categoryAttr) return null;

    const hasError = product.errors[`attribute-${attributeId}`];
    const attributeValue = productAttr || { attributeId, isForVariant: false };

    switch (categoryAttr.type) {
      case 'TEXT':
        return (
          <div className="space-y-1">
            <Input
              value={attributeValue.valueString || ''}
              onChange={(e) => onUpdateAttribute(product.id, attributeId, 'valueString', e.target.value)}
              placeholder={`Enter ${categoryAttr.name}${isRequired ? ' *' : ''}`}
              className={`h-8 text-sm ${hasError ? 'border-red-500' : ''}`}
            />
            {hasError && (
              <p className="text-xs text-red-500">{hasError}</p>
            )}
          </div>
        );

      case 'NUMBER':
        return (
          <div className="space-y-1">
            <Input
              type="number"
              value={attributeValue.valueNumber !== undefined ? attributeValue.valueNumber : ''}
              onChange={(e) => {
                const value = e.target.value === '' ? undefined : parseFloat(e.target.value);
                onUpdateAttribute(product.id, attributeId, 'valueNumber', value);
              }}
              placeholder={`Enter ${categoryAttr.name}${categoryAttr.unit ? ` (${categoryAttr.unit})` : ''}${isRequired ? ' *' : ''}`}
              className={`h-8 text-sm ${hasError ? 'border-red-500' : ''}`}
            />
            {hasError && (
              <p className="text-xs text-red-500">{hasError}</p>
            )}
          </div>
        );

      case 'BOOLEAN':
        return (
          <div className={`flex items-center space-x-2 ${hasError ? 'border-red-500 border rounded p-2' : ''}`}>
            <Checkbox
              id={`${product.id}-${attributeId}`}
              checked={attributeValue.valueBoolean || false}
              onCheckedChange={(checked) => 
                onUpdateAttribute(product.id, attributeId, 'valueBoolean', checked)
              }
            />
            <label 
              htmlFor={`${product.id}-${attributeId}`}
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              {categoryAttr.name}{isRequired ? ' *' : ''}
            </label>
            {hasError && (
              <AlertCircle className="h-3 w-3 text-red-500 ml-2" />
            )}
          </div>
        );

      case 'SELECT':
      case 'MULTISELECT':
        return (
          <div className="space-y-1">
            <Select
              value={attributeValue.attributeValueId || ''}
              onValueChange={(value) => 
                onUpdateAttribute(product.id, attributeId, 'attributeValueId', value)
              }
            >
              <SelectTrigger className={`h-8 text-sm ${hasError ? 'border-red-500' : ''}`}>
                <SelectValue placeholder={`Select ${categoryAttr.name}${isRequired ? ' *' : ''}`} />
              </SelectTrigger>
              <SelectContent>
                {categoryAttr.values?.map(value => (
                  <SelectItem key={value.id} value={value.id}>
                    {value.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasError && (
              <p className="text-xs text-red-500">{hasError}</p>
            )}
          </div>
        );

      default:
        return (
          <Input
            value={attributeValue.valueString || ''}
            onChange={(e) => onUpdateAttribute(product.id, attributeId, 'valueString', e.target.value)}
            placeholder={categoryAttr.name}
            className="h-8 text-sm"
          />
        );
    }
  };

  // Get required and optional attributes
  const requiredAttributes = categoryAttributes.filter(attr => attr.isRequired);
  const optionalAttributes = categoryAttributes.filter(attr => !attr.isRequired);

  return (
    <tr 
      id={`product-${product.id}`}
      className={`border-b hover:bg-gray-50 transition-colors ${
        product.status === 'error' ? 'bg-red-50' :
        product.status === 'processing' ? 'bg-blue-50' :
        product.status === 'success' ? 'bg-green-50' : ''
      }`}
    >
      {/* Index */}
      <td className="p-2 sticky left-0 bg-white">
        <div className="flex items-center justify-center">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center ${status.color} ${status.text}`}>
            {status.icon}
          </div>
          <span className="ml-2 text-sm font-medium">{index + 1}</span>
        </div>
        <div className="text-xs text-gray-500 mt-1 text-center">
          {status.label}
        </div>
      </td>

      {/* Basic Info */}
      <td className="p-2 align-top">
        <div className="space-y-2">
          {/* Name */}
          <div>
            <label className="text-xs font-medium text-gray-700 mb-1 block">Name *</label>
            <Input
              value={product.name}
              onChange={(e) => onUpdateField(product.id, 'name', e.target.value)}
              placeholder="Product name"
              className={`h-8 text-sm ${product.errors.name ? 'border-red-500' : ''}`}
            />
            {product.errors.name && (
              <p className="text-xs text-red-500 mt-1">{product.errors.name}</p>
            )}
          </div>

          {/* SKU */}
          <div>
            <label className="text-xs font-medium text-gray-700 mb-1 block">SKU *</label>
            <Input
              value={product.sku}
              onChange={(e) => onUpdateField(product.id, 'sku', e.target.value)}
              placeholder="SKU"
              className={`h-8 text-sm ${product.errors.sku ? 'border-red-500' : ''}`}
            />
            {product.errors.sku && (
              <p className="text-xs text-red-500 mt-1">{product.errors.sku}</p>
            )}
          </div>

          {/* Price & Stock */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium text-gray-700 mb-1 block">Price *</label>
              <Input
                type="number"
                step="0.01"
                value={product.price || ''}
                onChange={(e) => onUpdateField(product.id, 'price', parseFloat(e.target.value) || 0)}
                placeholder="0.00"
                className={`h-8 text-sm ${product.errors.price ? 'border-red-500' : ''}`}
              />
              {product.errors.price && (
                <p className="text-xs text-red-500 mt-1">{product.errors.price}</p>
              )}
            </div>
            <div>
              <label className="text-xs font-medium text-gray-700 mb-1 block">Stock *</label>
              <Input
                type="number"
                value={product.stock || ''}
                onChange={(e) => onUpdateField(product.id, 'stock', parseInt(e.target.value) || 0)}
                placeholder="0"
                className={`h-8 text-sm ${product.errors.stock ? 'border-red-500' : ''}`}
              />
              {product.errors.stock && (
                <p className="text-xs text-red-500 mt-1">{product.errors.stock}</p>
              )}
            </div>
          </div>

          {/* Variant Group */}
          <div>
            <label className="text-xs font-medium text-gray-700 mb-1 block">Variant Group</label>
            <Input
              type="number"
              value={product.variantGroupNo || ''}
              onChange={(e) => onUpdateField(product.id, 'variantGroupNo', e.target.value ? parseInt(e.target.value) : undefined)}
              placeholder="Optional"
              className="h-8 text-sm"
            />
          </div>
        </div>
      </td>

      {/* Required Attributes */}
      <td className="p-2 align-top">
        {requiredAttributes.length === 0 ? (
          <div className="text-center py-4 text-sm text-gray-500">
            No required attributes
          </div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-2">
            {requiredAttributes.map(attr => {
              const productAttr = getProductAttribute(attr.id);
              return (
                <div key={attr.id} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-red-700 flex items-center">
                      {attr.name}
                      <span className="text-red-500 ml-1">*</span>
                      {attr.unit && (
                        <span className="text-gray-500 ml-1">({attr.unit})</span>
                      )}
                    </label>
                    
                    {/* Include in Variant toggle */}
                    <div className="flex items-center space-x-1">
                      <span className="text-xs text-gray-500">Variant</span>
                      <Switch
                        checked={productAttr?.isForVariant || false}
                        onCheckedChange={() => onToggleAttributeForVariant(product.id, attr.id)}
                        className="h-3 w-6"
                      />
                    </div>
                  </div>
                  
                  {renderAttributeInput(attr.id, true)}
                  
                  {attr.type === 'SELECT' && attr.values && (
                    <div className="text-xs text-gray-500">
                      {attr.values.length} options
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </td>

      {/* Optional Attributes */}
      <td className="p-2 align-top">
        {optionalAttributes.length === 0 ? (
          <div className="text-center py-4 text-sm text-gray-500">
            No optional attributes
          </div>
        ) : (
          <div className="space-y-2 max-h-80 overflow-y-auto pr-2">
            {optionalAttributes.map(attr => {
              const productAttr = getProductAttribute(attr.id);
              return (
                <div key={attr.id} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-blue-700">
                      {attr.name}
                      {attr.unit && (
                        <span className="text-gray-500 ml-1">({attr.unit})</span>
                      )}
                    </label>
                    
                    {/* Include in Variant toggle */}
                    <div className="flex items-center space-x-1">
                      <span className="text-xs text-gray-500">Variant</span>
                      <Switch
                        checked={productAttr?.isForVariant || false}
                        onCheckedChange={() => onToggleAttributeForVariant(product.id, attr.id)}
                        className="h-3 w-6"
                      />
                    </div>
                  </div>
                  
                  {renderAttributeInput(attr.id, false)}
                  
                  {attr.type === 'SELECT' && attr.values && (
                    <div className="text-xs text-gray-500">
                      {attr.values.length} options
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </td>

      {/* Media & Details */}
      <td className="p-2 align-top">
        <div className="space-y-2">
          {/* Images */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Images</label>
            <div className="flex items-center gap-2">
              <Dialog open={imageDialogOpen} onOpenChange={setImageDialogOpen}>
                <DialogTrigger asChild>
                  <Button 
                    variant={product.images.length > 0 ? "default" : "outline"} 
                    size="sm" 
                    className="h-8 flex items-center gap-1"
                  >
                    <ImageIcon className="h-4 w-4" />
                    <span>{product.images.length || 0}</span>
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Manage Images</DialogTitle>
                    <DialogDescription>
                      Upload product images (max 10)
                    </DialogDescription>
                  </DialogHeader>
                  <ImageUploader 
                    images={product.images} 
                    setImages={(images) => onUpdateImages(product.id, images)} 
                    maxImages={10} 
                  />
                </DialogContent>
              </Dialog>
              {product.errors.images && (
                <span className="text-xs text-red-500">{product.errors.images}</span>
              )}
            </div>
          </div>

          {/* Video */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Video</label>
            <Dialog open={videoDialogOpen} onOpenChange={setVideoDialogOpen}>
              <DialogTrigger asChild>
                <Button 
                  variant={product.videoUrl ? "default" : "outline"} 
                  size="sm" 
                  className="h-8 flex items-center gap-1"
                >
                  <Video className="h-4 w-4" />
                  {product.videoUrl ? 'Edit' : 'Add'}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Manage Video</DialogTitle>
                  <DialogDescription>
                    Upload or link a product video (optional)
                  </DialogDescription>
                </DialogHeader>
                <VideoUploader
                  videoUrl={product.videoUrl ?? null}
                  setVideoUrl={(videoUrl) => onUpdateVideo(product.id, videoUrl)}
                  vendorId={vendorId || ""}
                  userRole={userRole}
                />
              </DialogContent>
            </Dialog>
          </div>

          {/* Description */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Description</label>
            <Dialog open={descriptionDialogOpen} onOpenChange={setDescriptionDialogOpen}>
              <DialogTrigger asChild>
                <Button 
                  variant={product.description ? "default" : "outline"} 
                  size="sm" 
                  className="h-8 flex items-center gap-1"
                >
                  <FileText className="h-4 w-4" />
                  {product.description ? 'Edit' : 'Add'}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Edit Description</DialogTitle>
                </DialogHeader>
                <div className="pt-4">
                  <ProductDescriptionEditor
                    value={product.description}
                    onChange={(value) => onUpdateField(product.id, 'description', value)}
                  />
                  <Button 
                    onClick={() => setDescriptionDialogOpen(false)} 
                    className="w-full mt-4"
                  >
                    Save Description
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {/* Shipping & Warranty */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-gray-700">Shipping & Warranty</label>
            <Dialog open={shippingDialogOpen} onOpenChange={setShippingDialogOpen}>
              <DialogTrigger asChild>
                <Button 
                  variant={product.shippingWarranty ? "default" : "outline"} 
                  size="sm" 
                  className="h-8 flex items-center gap-1"
                >
                  <Package className="h-4 w-4" />
                  {product.shippingWarranty ? 'Edit' : 'Add'}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Shipping & Warranty Information</DialogTitle>
                </DialogHeader>
                <div className="pt-4">
                  <ShippingWarrantyForm
                    value={product.shippingWarranty ?? null}
                    onChange={(value) => onUpdateShippingWarranty(product.id, value)}
                    validationErrors={{}}
                  />
                  <Button 
                    onClick={() => setShippingDialogOpen(false)} 
                    className="w-full mt-4"
                  >
                    Save
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </td>

      {/* Variants */}
      <td className="p-2 align-top">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-gray-700">
              Variants ({product.variantInputs.length})
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onAddVariant(product.id)}
              className="h-6 w-6 p-0"
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>
          
          {product.variantInputs.length === 0 ? (
            <p className="text-xs text-gray-500">No variants added</p>
          ) : (
            <div className="space-y-1 max-h-40 overflow-y-auto pr-2">
              {product.variantInputs.map((variant, vIndex) => (
                <div 
                  key={variant.id || vIndex} 
                  className="flex items-center justify-between p-1 border rounded text-xs"
                >
                  <div className="truncate">
                    <div className="font-medium">{variant.name || `Variant ${vIndex + 1}`}</div>
                    <div className="text-gray-500">৳{variant.price.toFixed(2)}</div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Dialog open={variantsDialogOpen} onOpenChange={setVariantsDialogOpen}>
                      <DialogTrigger asChild>
                        <Button 
                          variant="ghost" 
                          size="sm" 
                          className="h-5 w-5 p-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            // You'd need to manage which variant is being edited
                          }}
                        >
                          <Edit className="h-3 w-3" />
                        </Button>
                      </DialogTrigger>
                    </Dialog>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onRemoveVariant(product.id, variant.id!)}
                      className="h-5 w-5 p-0 text-red-500 hover:text-red-700"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </td>

      {/* Actions */}
      <td className="p-2 sticky right-0 bg-white align-top">
        <div className="space-y-1">
          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => {
              if (window.confirm('Are you sure you want to remove this product?')) {
                onRemove(product.id);
              }
            }}
            className="h-8 w-full text-red-500 hover:text-red-700 hover:bg-red-50 flex items-center gap-1"
          >
            <Trash2 className="h-4 w-4" />
            <span className="text-xs">Remove</span>
          </Button>
          
          {product.errors.api && (
            <div className="text-xs text-red-500 bg-red-50 p-1 rounded border border-red-200 mt-1">
              {product.errors.api}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}