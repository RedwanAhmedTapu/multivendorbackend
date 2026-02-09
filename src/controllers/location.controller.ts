import type { Request, Response } from "express";
import { LocationService } from "../services/location.service.ts";

export const LocationController = {
  /**
   * GET /api/locations
   * Get all locations with hierarchy
   */
  async getAll(req: Request, res: Response) {
    try {
      const locations = await LocationService.getAll();
      res.json({
        success: true,
        data: locations,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch locations",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/locations/level/:level
   * Get locations by level with optional parent filter
   */
  async getByLevel(req: Request, res: Response) {
    try {
      const { level } = req.params;
      const { parentId } = req.query;

      const validLevels = ["DIVISION", "DISTRICT", "THANA"];
      if (!validLevels.includes(level.toUpperCase())) {
        return res.status(400).json({
          success: false,
          message: "Invalid level. Must be DIVISION, DISTRICT, or THANA",
        });
      }

      const locations = await LocationService.getByLevel(
        level.toUpperCase() as any,
        parentId as string | undefined
      );

      res.json({
        success: true,
        data: locations,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch locations by level",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/locations/:id
   * Get location by ID with hierarchy
   */
  async getById(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const location = await LocationService.getById(id);

      if (!location) {
        return res.status(404).json({
          success: false,
          message: "Location not found",
        });
      }

      res.json({
        success: true,
        data: location,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch location",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/locations/divisions
   * Get all divisions (root level locations)
   */
  async getDivisions(req: Request, res: Response) {
    try {
      const divisions = await LocationService.getDivisions();
      res.json({
        success: true,
        data: divisions,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch divisions",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/locations/districts
   * Get districts, optionally filtered by division ID
   * Query params: divisionId (optional)
   */
  async getDistricts(req: Request, res: Response) {
    try {
      const { divisionId } = req.query;
      
      if (divisionId && typeof divisionId !== 'string') {
        return res.status(400).json({
          success: false,
          message: "Invalid divisionId parameter",
        });
      }

      const districts = await LocationService.getDistricts(
        divisionId as string | undefined
      );
      
      res.json({
        success: true,
        data: districts,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch districts",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/locations/thanas
   * Get thanas, optionally filtered by district ID
   * Query params: districtId (optional)
   */
  async getThanas(req: Request, res: Response) {
    try {
      const { districtId } = req.query;
      
      if (districtId && typeof districtId !== 'string') {
        return res.status(400).json({
          success: false,
          message: "Invalid districtId parameter",
        });
      }

      const thanas = await LocationService.getThanas(
        districtId as string | undefined
      );
      
      res.json({
        success: true,
        data: thanas,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch thanas",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/locations/children/:parentId
   * Get all children of a specific location
   */
  async getChildren(req: Request, res: Response) {
    try {
      const { parentId } = req.params;
      const children = await LocationService.getChildren(parentId);
      
      res.json({
        success: true,
        data: children,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch children locations",
        error: error.message,
      });
    }
  },

  /**
   * POST /api/locations
   * Create a new location
   */
  async create(req: Request, res: Response) {
    try {
      const location = await LocationService.create(req.body);
      res.status(201).json({
        success: true,
        data: location,
        message: "Location created successfully",
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: "Failed to create location",
        error: error.message,
      });
    }
  },

  /**
   * PUT /api/locations/:id
   * Update a location
   */
  async update(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const location = await LocationService.update(id, req.body);
      res.json({
        success: true,
        data: location,
        message: "Location updated successfully",
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: "Failed to update location",
        error: error.message,
      });
    }
  },

  /**
   * DELETE /api/locations/:id
   * Delete a location
   */
  async remove(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const location = await LocationService.remove(id);
      res.json({
        success: true,
        data: location,
        message: "Location deleted successfully",
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: "Failed to delete location",
        error: error.message,
      });
    }
  },

  /**
   * POST /api/locations/bulk-upload
   * Bulk upload locations from CSV/Excel
   */
  async bulkUpload(req: Request, res: Response) {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No file uploaded",
        });
      }

      // Convert the uploaded file buffer to a File object
      const file = new File([req.file.buffer], req.file.originalname, {
        type: req.file.mimetype,
      });

      const results = await LocationService.bulkUpload(file);

      res.json({
        success: true,
        data: results,
        message: "Bulk upload completed",
      });
    } catch (error: any) {
      res.status(400).json({
        success: false,
        message: "Failed to upload locations",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/locations/search
   * Search locations by name
   */
  async search(req: Request, res: Response) {
    try {
      const { q, level } = req.query;

      if (!q || typeof q !== "string") {
        return res.status(400).json({
          success: false,
          message: "Search query is required",
        });
      }

      const locations = await LocationService.search(
        q,
        level as any
      );

      res.json({
        success: true,
        data: locations,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to search locations",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/locations/leaf
   * Get leaf locations
   */
  async getLeafLocations(req: Request, res: Response) {
    try {
      const { level } = req.query;
      const locations = await LocationService.getLeafLocations(level as any);
      res.json({
        success: true,
        data: locations,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch leaf locations",
        error: error.message,
      });
    }
  },

  /**
   * GET /api/locations/cod
   * Get COD-supported locations
   */
  async getCodLocations(req: Request, res: Response) {
    try {
      const { includeDgCod } = req.query;
      const locations = await LocationService.getCodLocations(
        includeDgCod === "true"
      );
      res.json({
        success: true,
        data: locations,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch COD locations",
        error: error.message,
      });
    }
  },
};