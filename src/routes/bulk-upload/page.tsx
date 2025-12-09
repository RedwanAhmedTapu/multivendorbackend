// components/bulkupload/BulkUploadPage.tsx
"use client";
import React, { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useCreateProductMutation } from "@/features/productApi";
import type { Attribute } from "@/types/type";
import {
  CreateProductData,
  ProductAttributeInput,
  ProductImageInput,
  ProductShippingWarrantyInput,
  ProductVariantInput,
  BulkProductData,
} from "@/types/product";
import { useSelector } from "react-redux";
import { RootState } from "@/store/store";
import CategoryTreeSelector from "@/components/product/vendor/productform/CategoryTreeSelector";
import { BulkUploadProgress } from "./BulkUploadProgress";
import { ProductsTable } from "./ProductsTable";
import { BulkUploadInstructions } from "./BulkUploadInstructions";

// Fix 1: Extend the Attribute type to include isRequired
interface ExtendedAttribute extends Attribute {
  isRequired?: boolean;
}

interface ExtendedBulkProductData extends Omit<BulkProductData, 'attributes' | 'variantInputs'> {
  attributes: ProductAttributeInput[];
  variantInputs: ProductVariantInput[];
}

// Fix 2: Type for attribute update field
type AttributeValueField = 'valueString' | 'valueNumber' | 'valueBoolean' | 'attributeValueId';

export default function BulkUploadPage() {
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryPath, setCategoryPath] = useState<string>("");
  const [isLeafCategory, setIsLeafCategory] = useState(false);
  const [categoryAttributes, setCategoryAttributes] = useState<ExtendedAttribute[]>([]);
  const [categorySelected, setCategorySelected] = useState(false);
  
  const [products, setProducts] = useState<ExtendedBulkProductData[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [productsPerPage] = useState(10);
  const [hasInitialized, setHasInitialized] = useState(false);
  
  const [createProduct, { isLoading }] = useCreateProductMutation();

  const { user } = useSelector((state: RootState) => state.auth);
  const vendorId = user?.vendorId;
  const userRole = user?.role as "VENDOR" | "ADMIN";

  // Helper function to initialize attributes for a product
  const initializeAttributes = useCallback((): ProductAttributeInput[] => {
    return categoryAttributes.map(attr => {
      const attrInput: ProductAttributeInput = {
        attributeId: attr.id,
        isForVariant: false, // Default to specification
      };

      // Initialize based on attribute type
      if (attr.type === 'BOOLEAN') {
        attrInput.valueBoolean = false;
      } else if (attr.type === 'NUMBER') {
        attrInput.valueNumber = 0;
      } else if (attr.type === 'TEXT') {
        attrInput.valueString = "";
      }

      return attrInput;
    });
  }, [categoryAttributes]);

  // Add new product
  const addNewProduct = useCallback(() => {
    const newProduct: ExtendedBulkProductData = {
      id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
      name: "",
      description: "",
      sku: "",
      price: 0,
      stock: 0,
      approvalStatus: 'PENDING',
      variantGroupNo: undefined,
      images: [],
      videoUrl: "",
      attributes: initializeAttributes(),
      variantInputs: [],
      shippingWarranty: undefined,
      errors: {},
      status: 'draft'
    };
    setProducts(prev => [...prev, newProduct]);
    
    const totalPages = Math.ceil((products.length + 1) / productsPerPage);
    if (totalPages > currentPage) {
      setCurrentPage(totalPages);
    }
  }, [initializeAttributes, products.length, currentPage, productsPerPage]);

  // Initialize only once when category becomes leaf
  useEffect(() => {
    if (isLeafCategory && !hasInitialized && products.length === 0) {
      addNewProduct();
      setHasInitialized(true);
    }
  }, [isLeafCategory, hasInitialized, products.length, addNewProduct]);

  // Handle category selection
  const handleCategorySelect = (
    id: string,
    path: string,
    isLeaf: boolean,
    attributes: Attribute[]
  ) => {
    setCategoryId(id);
    setCategoryPath(path);
    setIsLeafCategory(isLeaf);
    setCategoryAttributes(attributes as ExtendedAttribute[]);
    setCategorySelected(true);
    setHasInitialized(false);
    setCurrentPage(1);
    setProducts([]);

    if (isLeaf) {
      const initialProduct: ExtendedBulkProductData = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
        name: "",
        description: "",
        sku: "",
        price: 0,
        stock: 0,
        approvalStatus: 'PENDING',
        variantGroupNo: undefined,
        images: [],
        videoUrl: "",
        attributes: attributes.map(attr => {
          const attrInput: ProductAttributeInput = {
            attributeId: attr.id,
            isForVariant: false, // Default to specification
          };

          // Initialize based on attribute type
          if (attr.type === 'BOOLEAN') {
            attrInput.valueBoolean = false;
          } else if (attr.type === 'NUMBER') {
            attrInput.valueNumber = 0;
          } else if (attr.type === 'TEXT') {
            attrInput.valueString = "";
          }

          return attrInput;
        }),
        variantInputs: [],
        shippingWarranty: undefined,
        errors: {},
        status: 'draft'
      };
      setProducts([initialProduct]);
      setHasInitialized(true);
    } else {
      setCategorySelected(false);
      alert("⚠️ Please select a leaf category (one without subcategories) to proceed with bulk upload.");
    }
  };

  // Change category
  const handleChangeCategory = () => {
    if (window.confirm("Are you sure you want to change category? All unsaved data will be lost.")) {
      setCategorySelected(false);
      setCategoryId(null);
      setCategoryPath("");
      setIsLeafCategory(false);
      setCategoryAttributes([]);
      setProducts([]);
      setCurrentPage(1);
      setHasInitialized(false);
    }
  };

  // Remove product row
  const removeProduct = (productId: string) => {
    if (products.length > 1) {
      setProducts(prev => {
        const updatedProducts = prev.filter(p => p.id !== productId);
        const totalPages = Math.ceil(updatedProducts.length / productsPerPage);
        if (currentPage > totalPages) {
          setCurrentPage(totalPages);
        }
        return updatedProducts;
      });
    } else {
      alert("At least one product is required.");
    }
  };

  // Update product field
  const updateProductField = (productId: string, field: string, value: any) => {
    setProducts(prev => prev.map(product => {
      if (product.id === productId) {
        const updated = { ...product, [field]: value };
        const errors = validateProductField(updated, field, value);
        return { ...updated, errors: { ...product.errors, ...errors } };
      }
      return product;
    }));
  };

  // Update attribute value
  const updateAttributeValue = (
    productId: string, 
    attributeId: string, 
    field: AttributeValueField, 
    value: any
  ) => {
    setProducts(prev => prev.map(product => {
      if (product.id === productId) {
        const updatedAttributes = product.attributes.map(attr => {
          if (attr.attributeId === attributeId) {
            // Clear other value fields when setting a new value
            const updatedAttr: ProductAttributeInput = {
              ...attr,
              [field]: value,
            };

            // Clear other value fields based on the type of value being set
            if (field === 'valueString') {
              updatedAttr.valueNumber = undefined;
              updatedAttr.valueBoolean = undefined;
              updatedAttr.attributeValueId = undefined;
            } else if (field === 'valueNumber') {
              updatedAttr.valueString = undefined;
              updatedAttr.valueBoolean = undefined;
              updatedAttr.attributeValueId = undefined;
            } else if (field === 'valueBoolean') {
              updatedAttr.valueString = undefined;
              updatedAttr.valueNumber = undefined;
              updatedAttr.attributeValueId = undefined;
            } else if (field === 'attributeValueId') {
              updatedAttr.valueString = undefined;
              updatedAttr.valueNumber = undefined;
              updatedAttr.valueBoolean = undefined;
            }

            return updatedAttr;
          }
          return attr;
        });

        return { ...product, attributes: updatedAttributes };
      }
      return product;
    }));
  };

  // Toggle attribute for variant inclusion
  const toggleAttributeForVariant = (productId: string, attributeId: string) => {
    setProducts(prev => prev.map(product => {
      if (product.id === productId) {
        const updatedAttributes = product.attributes.map(attr => {
          if (attr.attributeId === attributeId) {
            return { ...attr, isForVariant: !attr.isForVariant };
          }
          return attr;
        });

        return { ...product, attributes: updatedAttributes };
      }
      return product;
    }));
  };

  // Update product images
  const updateProductImages = (productId: string, images: string[]) => {
    setProducts(prev => prev.map(product =>
      product.id === productId ? { ...product, images } : product
    ));
  };

  // Update product video
  const updateProductVideo = (productId: string, videoUrl: string | null) => {
    setProducts(prev => prev.map(product =>
      product.id === productId ? { ...product, videoUrl: videoUrl ?? "" } : product
    ));
  };

  // Update product shipping warranty
  const updateProductShippingWarranty = (
    productId: string, 
    shippingWarranty: ProductShippingWarrantyInput | undefined
  ) => {
    setProducts(prev => prev.map(product =>
      product.id === productId ? { ...product, shippingWarranty } : product
    ));
  };

  // Add variant to product
  const addVariantToProduct = (productId: string) => {
    setProducts(prev => prev.map(product => {
      if (product.id === productId) {
        const variantCount = product.variantInputs.length;
        const newVariant: ProductVariantInput = {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 9),
          name: `Variant ${variantCount + 1}`,
          sku: `${product.sku || 'PROD'}-V${variantCount + 1}`,
          price: product.price,
          stock: product.stock,
          images: [],
        };

        return {
          ...product,
          variantInputs: [...product.variantInputs, newVariant]
        };
      }
      return product;
    }));
  };

  // Update variant
  const updateVariant = (
    productId: string,
    variantId: string,
    field: keyof ProductVariantInput,
    value: any
  ) => {
    setProducts(prev => prev.map(product => {
      if (product.id === productId) {
        const updatedVariants = product.variantInputs.map(variant => {
          if (variant.id === variantId) {
            return { ...variant, [field]: value };
          }
          return variant;
        });

        return { ...product, variantInputs: updatedVariants };
      }
      return product;
    }));
  };

  // Remove variant
  const removeVariant = (productId: string, variantId: string) => {
    setProducts(prev => prev.map(product => {
      if (product.id === productId) {
        const updatedVariants = product.variantInputs.filter(v => v.id !== variantId);
        return { ...product, variantInputs: updatedVariants };
      }
      return product;
    }));
  };

  // Validate product field
  const validateProductField = (
    product: ExtendedBulkProductData, 
    field: string, 
    value: any
  ): Record<string, string> => {
    const errors: Record<string, string> = {};

    switch (field) {
      case 'name':
        if (!value || value.trim().length === 0) {
          errors.name = 'Required';
        } else if (value.length > 200) {
          errors.name = 'Too long (max 200 chars)';
        }
        break;

      case 'sku':
        if (!value || value.trim().length === 0) {
          errors.sku = 'Required';
        } else {
          const duplicateCount = products.filter(p => 
            p.id !== product.id && p.sku === value && value.trim() !== ''
          ).length;
          if (duplicateCount > 0) {
            errors.sku = 'Duplicate SKU';
          }
        }
        break;

      case 'price':
        if (value === null || value === undefined || value < 0) {
          errors.price = 'Invalid price';
        } else if (value === 0) {
          errors.price = 'Price must be greater than 0';
        }
        break;

      case 'stock':
        if (value === null || value === undefined || value < 0) {
          errors.stock = 'Invalid stock';
        } else if (!Number.isInteger(Number(value))) {
          errors.stock = 'Must be integer';
        }
        break;
    }

    return errors;
  };

  // Validate required attributes
  const validateRequiredAttributes = (product: ExtendedBulkProductData): Record<string, string> => {
    const errors: Record<string, string> = {};

    categoryAttributes.forEach(categoryAttr => {
      const isRequired = categoryAttr.isRequired;
      if (isRequired) {
        const productAttr = product.attributes.find(a => a.attributeId === categoryAttr.id);
        
        if (!productAttr) {
          errors[`attribute-${categoryAttr.id}`] = `${categoryAttr.name} is required`;
          return;
        }

        const hasValue = 
          (productAttr.valueString !== undefined && productAttr.valueString !== null && productAttr.valueString.trim() !== '') ||
          (productAttr.valueNumber !== undefined && productAttr.valueNumber !== null) ||
          (productAttr.valueBoolean !== undefined && productAttr.valueBoolean !== null) ||
          (productAttr.attributeValueId !== undefined && productAttr.attributeValueId !== null && productAttr.attributeValueId.trim() !== '');

        if (!hasValue) {
          errors[`attribute-${categoryAttr.id}`] = `${categoryAttr.name} is required`;
        }
      }
    });

    return errors;
  };

  // Validate all products
  const validateAllProducts = (): boolean => {
    const updatedProducts = products.map(product => {
      const errors: Record<string, string> = {};

      // Basic validation
      if (!product.name.trim()) errors.name = 'Product name is required';
      if (!product.sku.trim()) errors.sku = 'SKU is required';
      if (product.price <= 0) errors.price = 'Price must be greater than 0';
      if (product.stock < 0) errors.stock = 'Stock cannot be negative';

      // SKU duplication
      const duplicateSkus = products.filter(p => 
        p.id !== product.id && p.sku === product.sku && p.sku.trim() !== ''
      );
      if (duplicateSkus.length > 0) {
        errors.sku = 'Duplicate SKU';
      }

      // Required attributes
      const attributeErrors = validateRequiredAttributes(product);
      Object.assign(errors, attributeErrors);

      // Check if at least one image is provided
      if (product.images.length === 0) {
        errors.images = 'At least one image is required';
      }

      return { ...product, errors };
    });

    setProducts(updatedProducts);
    
    const hasErrors = updatedProducts.some(product => Object.keys(product.errors).length > 0);
    if (hasErrors) {
      // Scroll to first error
      const firstErrorProduct = updatedProducts.find(p => Object.keys(p.errors).length > 0);
      if (firstErrorProduct) {
        const firstErrorId = `product-${firstErrorProduct.id}`;
        const errorElement = document.getElementById(firstErrorId);
        if (errorElement) {
          errorElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }
    
    return !hasErrors;
  };

  // Process bulk upload
  const processBulkUpload = async () => {
    if (!validateAllProducts()) {
      alert('❌ Please fix all validation errors before submitting.');
      return;
    }

    if (!categoryId || !vendorId) {
      alert('❌ Category and vendor information is required.');
      return;
    }

    const confirmed = window.confirm(`Are you sure you want to upload ${products.length} products?`);
    if (!confirmed) return;

    setProducts(prev => prev.map(p => ({ ...p, status: 'processing' })));

    const results = [];
    let successCount = 0;
    let errorCount = 0;
    
    for (const product of products) {
      try {
        // Filter out attributes that have no value
        const validAttributes = product.attributes.filter(attr => {
          return (
            (attr.valueString !== undefined && attr.valueString !== null && attr.valueString.trim() !== '') ||
            (attr.valueNumber !== undefined && attr.valueNumber !== null) ||
            (attr.valueBoolean !== undefined && attr.valueBoolean !== null) ||
            (attr.attributeValueId !== undefined && attr.attributeValueId !== null && attr.attributeValueId.trim() !== '')
          );
        });

        const productData: CreateProductData = {
          name: product.name,
          description: product.description || undefined,
          categoryId: categoryId!,
          vendorId: vendorId!,
          images: product.images.map((url, index) => ({
            url,
            altText: `${product.name} image ${index + 1}`,
            sortOrder: index,
          })),
          videoUrl: product.videoUrl || undefined,
          attributes: validAttributes,
          variants: product.variantInputs,
          shippingWarranty: product.shippingWarranty,
        };

        const result = await createProduct(productData).unwrap();
        results.push({ success: true, productId: product.id, data: result });
        successCount++;
        
        setProducts(prev => prev.map(p => 
          p.id === product.id ? { ...p, status: 'success' } : p
        ));
        
      } catch (error: any) {
        console.error(`Failed to create product ${product.name}:`, error);
        const errorMessage = error?.data?.message || error?.message || 'Unknown error';
        results.push({ success: false, productId: product.id, error: errorMessage });
        errorCount++;
        
        setProducts(prev => prev.map(p => 
          p.id === product.id ? { 
            ...p, 
            status: 'error',
            errors: { ...p.errors, api: errorMessage }
          } : p
        ));
      }
    }

    const message = `✅ Bulk upload completed!\n\nSuccess: ${successCount}\nFailed: ${errorCount}\n\n${successCount > 0 ? 'Successful products have been created.' : ''}\n${errorCount > 0 ? 'Failed products are marked in red. Check the error details.' : ''}`;
    
    alert(message);
    
    // Optionally clear successful products after some time
    if (successCount > 0) {
      setTimeout(() => {
        if (window.confirm('Remove successfully uploaded products from the list?')) {
          setProducts(prev => prev.filter(p => p.status !== 'success'));
        }
      }, 2000);
    }
  };

  // Quick add multiple rows
  const quickAddRows = (count: number) => {
    const total = products.length + count;
    if (total > 100) {
      alert('Maximum 100 products allowed per bulk upload.');
      return;
    }
    
    for (let i = 0; i < count; i++) {
      addNewProduct();
    }
  };

  // Get current page products
  const indexOfLastProduct = currentPage * productsPerPage;
  const indexOfFirstProduct = indexOfLastProduct - productsPerPage;
  const currentProducts = products.slice(indexOfFirstProduct, indexOfLastProduct);
  const totalPages = Math.ceil(products.length / productsPerPage);

  // Calculate statistics
  const draftCount = products.filter(p => p.status === 'draft').length;
  const processingCount = products.filter(p => p.status === 'processing').length;
  const successCount = products.filter(p => p.status === 'success').length;
  const errorCount = products.filter(p => p.status === 'error').length;

  return (
    <div className="container mx-auto p-4 md:p-6 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Bulk Product Upload</h1>
          <p className="text-sm text-gray-600 mt-1">
            Upload multiple products at once for selected category
          </p>
        </div>
        {products.length > 0 && (
          <div className="text-sm text-gray-600 bg-white px-3 py-2 rounded-lg border">
            Showing {indexOfFirstProduct + 1}-{Math.min(indexOfLastProduct, products.length)} of {products.length} products
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Main Content */}
        <div className="lg:col-span-3 space-y-6">
          {/* Category Selection */}
          {!categorySelected && (
            <Card>
              <CardHeader>
                <CardTitle>1. Select Category</CardTitle>
                <p className="text-sm text-gray-600 mt-1">Choose a leaf category to start bulk upload</p>
              </CardHeader>
              <CardContent>
                <CategoryTreeSelector onSelect={handleCategorySelect} />
              </CardContent>
            </Card>
          )}

          {/* Selected Category Info */}
          {categorySelected && isLeafCategory && (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Selected Category ✓</CardTitle>
                  <p className="text-sm text-gray-600 mt-1">{categoryPath}</p>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">
                      {categoryAttributes.length} attributes
                    </span>
                    <span className="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
                      {categoryAttributes.filter(a => a.isRequired).length} required
                    </span>
                    <span className="text-xs bg-purple-100 text-purple-800 px-2 py-1 rounded">
                      {products.length} products in draft
                    </span>
                  </div>
                </div>
                <Button variant="outline" onClick={handleChangeCategory}>
                  Change Category
                </Button>
              </CardHeader>
            </Card>
          )}

          {/* Warning for non-leaf categories */}
          {categorySelected && !isLeafCategory && (
            <Card className="border-yellow-200">
              <CardHeader>
                <CardTitle className="text-yellow-800">Invalid Category Selection</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="bg-yellow-50 border border-yellow-200 p-4 rounded-lg">
                  <p className="text-yellow-800">
                    ⚠️ Please select a leaf category to add products. 
                    The selected category "{categoryPath}" is not a leaf category.
                  </p>
                  <Button 
                    onClick={handleChangeCategory} 
                    variant="outline" 
                    className="mt-3"
                  >
                    Select Different Category
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Products Table */}
          {categorySelected && isLeafCategory && (
            <ProductsTable
              products={currentProducts}
              categoryAttributes={categoryAttributes}
              totalProducts={products.length}
              currentPage={currentPage}
              totalPages={totalPages}
              onUpdateField={updateProductField}
              onUpdateAttribute={updateAttributeValue}
              onToggleAttributeForVariant={toggleAttributeForVariant}
              onUpdateImages={updateProductImages}
              onUpdateVideo={updateProductVideo}
              onUpdateShippingWarranty={updateProductShippingWarranty}
              onAddVariant={addVariantToProduct}
              onUpdateVariant={updateVariant}
              onRemoveVariant={removeVariant}
              onRemoveProduct={removeProduct}
              onAddProduct={addNewProduct}
              onQuickAddRows={quickAddRows}
              onUploadAll={processBulkUpload}
              onPageChange={setCurrentPage}
              isLoading={isLoading}
              vendorId={vendorId}
              userRole={userRole}
            />
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          <BulkUploadInstructions />
          <BulkUploadProgress 
            products={products}
            draftCount={draftCount}
            processingCount={processingCount}
            successCount={successCount}
            errorCount={errorCount}
          />
        </div>
      </div>
    </div>
  );
}