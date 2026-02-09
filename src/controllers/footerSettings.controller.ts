// src/controllers/footerSettings.controller.ts
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// GET - Fetch active footer settings with columns and elements
export const getFooterSettings = async (req: Request, res: Response) => {
  try {
    const footerSettings = await prisma.footerSettings.findFirst({
      where: { isActive: true },
      include: {
        columns: {
          where: { isVisible: true },
          include: {
            elements: {
              where: { isVisible: true },
              orderBy: { displayOrder: "asc" },
            },
          },
        },
      },
    });

    if (!footerSettings) {
      return res.status(404).json({
        success: false,
        error: "Footer settings not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: footerSettings,
    });
  } catch (error) {
    console.error("Error fetching footer settings:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch footer settings",
    });
  }
};

// GET - Fetch footer settings by ID
export const getFooterSettingsById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const footerSettings = await prisma.footerSettings.findUnique({
      where: { id },
      include: {
        columns: {
          include: {
            elements: {
              orderBy: { displayOrder: "asc" },
            },
          },
        },
      },
    });

    if (!footerSettings) {
      return res.status(404).json({
        success: false,
        error: "Footer settings not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: footerSettings,
    });
  } catch (error) {
    console.error("Error fetching footer settings:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch footer settings",
    });
  }
};

// POST - Create footer settings with columns and elements
export const createFooterSettings = async (req: Request, res: Response) => {
  try {
    // Check if settings already exist
    const existingSettings = await prisma.footerSettings.findFirst({
      where: { isActive: true },
    });

    if (existingSettings) {
      return res.status(400).json({
        success: false,
        error: "Footer settings already exist. Use PUT to update.",
      });
    }

    const { columns, ...settingsData } = req.body;

    const footerSettings = await prisma.footerSettings.create({
      data: {
        ...settingsData,
        isActive: true,
        columns: columns
          ? {
              create: columns.map((column: any) => ({
                title: column.title,
                isVisible: column.isVisible !== undefined ? column.isVisible : true,
                elements: column.elements
                  ? {
                      create: column.elements.map((element: any) => ({
                        label: element.label,
                        url: element.url,
                        displayOrder: element.displayOrder || 0,
                        isVisible: element.isVisible !== undefined ? element.isVisible : true,
                        openInNewTab: element.openInNewTab || false,
                      })),
                    }
                  : undefined,
              })),
            }
          : undefined,
      },
      include: {
        columns: {
          include: {
            elements: true,
          },
        },
      },
    });

    return res.status(201).json({
      success: true,
      message: "Footer settings created successfully",
      data: footerSettings,
    });
  } catch (error) {
    console.error("Error creating footer settings:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to create footer settings",
    });
  }
};

// PUT - Update active footer settings
export const updateFooterSettings = async (req: Request, res: Response) => {
  try {
    // Find active settings
    const existingSettings = await prisma.footerSettings.findFirst({
      where: { isActive: true },
    });

    if (!existingSettings) {
      return res.status(404).json({
        success: false,
        error: "Footer settings not found",
      });
    }

    const { columns, ...settingsData } = req.body;

    // Update settings
    const updatedSettings = await prisma.footerSettings.update({
      where: { id: existingSettings.id },
      data: settingsData,
      include: {
        columns: {
          include: {
            elements: true,
          },
        },
      },
    });

    return res.status(200).json({
      success: true,
      message: "Footer settings updated successfully",
      data: updatedSettings,
    });
  } catch (error) {
    console.error("Error updating footer settings:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to update footer settings",
    });
  }
};

// PUT - Update footer settings by ID
export const updateFooterSettingsById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { columns, ...settingsData } = req.body;

    const updatedSettings = await prisma.footerSettings.update({
      where: { id },
      data: settingsData,
      include: {
        columns: {
          include: {
            elements: true,
          },
        },
      },
    });

    return res.status(200).json({
      success: true,
      message: "Footer settings updated successfully",
      data: updatedSettings,
    });
  } catch (error) {
    console.error("Error updating footer settings:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to update footer settings",
    });
  }
};

// DELETE - Soft delete active footer settings
export const deleteFooterSettings = async (req: Request, res: Response) => {
  try {
    const existingSettings = await prisma.footerSettings.findFirst({
      where: { isActive: true },
    });

    if (!existingSettings) {
      return res.status(404).json({
        success: false,
        error: "Footer settings not found",
      });
    }

    // Soft delete by setting isActive to false
    await prisma.footerSettings.update({
      where: { id: existingSettings.id },
      data: { isActive: false },
    });

    return res.status(200).json({
      success: true,
      message: "Footer settings deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting footer settings:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to delete footer settings",
    });
  }
};

// DELETE - Hard delete footer settings by ID (cascades to columns and elements)
export const deleteFooterSettingsById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.footerSettings.delete({
      where: { id },
    });

    return res.status(200).json({
      success: true,
      message: "Footer settings deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting footer settings:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to delete footer settings",
    });
  }
};

// ===== COLUMN MANAGEMENT =====

// POST - Add a new column to footer settings
export const addFooterColumn = async (req: Request, res: Response) => {
  try {
    const { footerSettingsId } = req.params;
    const { elements, ...columnData } = req.body;

    const column = await prisma.footerColumn.create({
      data: {
        ...columnData,
        footerSettingsId,
        isVisible: columnData.isVisible !== undefined ? columnData.isVisible : true,
        elements: elements
          ? {
              create: elements.map((element: any) => ({
                label: element.label,
                url: element.url,
                displayOrder: element.displayOrder || 0,
                isVisible: element.isVisible !== undefined ? element.isVisible : true,
                openInNewTab: element.openInNewTab || false,
              })),
            }
          : undefined,
      },
      include: {
        elements: true,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Footer column added successfully",
      data: column,
    });
  } catch (error) {
    console.error("Error adding footer column:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to add footer column",
    });
  }
};

// PUT - Update a footer column
export const updateFooterColumn = async (req: Request, res: Response) => {
  try {
    const { columnId } = req.params;
    const { elements, ...columnData } = req.body;

    const column = await prisma.footerColumn.update({
      where: { id: columnId },
      data: columnData,
      include: {
        elements: true,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Footer column updated successfully",
      data: column,
    });
  } catch (error) {
    console.error("Error updating footer column:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to update footer column",
    });
  }
};

// DELETE - Delete a footer column (cascades to elements)
export const deleteFooterColumn = async (req: Request, res: Response) => {
  try {
    const { columnId } = req.params;

    await prisma.footerColumn.delete({
      where: { id: columnId },
    });

    return res.status(200).json({
      success: true,
      message: "Footer column deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting footer column:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to delete footer column",
    });
  }
};

// ===== ELEMENT MANAGEMENT =====

// POST - Add a new element to a column
export const addFooterElement = async (req: Request, res: Response) => {
  try {
    const { columnId } = req.params;

    const element = await prisma.footerElement.create({
      data: {
        ...req.body,
        footerColumnId: columnId,
        displayOrder: req.body.displayOrder || 0,
        isVisible: req.body.isVisible !== undefined ? req.body.isVisible : true,
        openInNewTab: req.body.openInNewTab || false,
      },
    });

    return res.status(201).json({
      success: true,
      message: "Footer element added successfully",
      data: element,
    });
  } catch (error) {
    console.error("Error adding footer element:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to add footer element",
    });
  }
};

// PUT - Update a footer element
export const updateFooterElement = async (req: Request, res: Response) => {
  try {
    const { elementId } = req.params;

    const element = await prisma.footerElement.update({
      where: { id: elementId },
      data: req.body,
    });

    return res.status(200).json({
      success: true,
      message: "Footer element updated successfully",
      data: element,
    });
  } catch (error) {
    console.error("Error updating footer element:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to update footer element",
    });
  }
};

// DELETE - Delete a footer element
export const deleteFooterElement = async (req: Request, res: Response) => {
  try {
    const { elementId } = req.params;

    await prisma.footerElement.delete({
      where: { id: elementId },
    });

    return res.status(200).json({
      success: true,
      message: "Footer element deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting footer element:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to delete footer element",
    });
  }
};