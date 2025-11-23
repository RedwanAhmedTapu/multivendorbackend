import type { Request, Response } from "express";
import * as shippingProviderService from "../services/shippingProvider.service.ts";

// Create provider
export const createProvider = async (req: Request, res: Response) => {
  try {
    const provider = await shippingProviderService.createProvider(req.body);
    res.status(201).json(provider);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

// Get all providers
export const getProviders = async (_req: Request, res: Response) => {
  try {
    const providers = await shippingProviderService.getProviders();
    res.json(providers);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// Get active provider (for checkout usage)
export const getActiveProvider = async (_req: Request, res: Response) => {
  try {
    const provider = await shippingProviderService.getActiveProvider();
    if (!provider) return res.status(404).json({ error: "No active provider found" });
    res.json(provider);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};

// Update provider
export const updateProvider = async (req: Request, res: Response) => {
  try {
    const provider = await shippingProviderService.updateProvider(req.params.id, req.body);
    res.json(provider);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

// Delete provider
export const deleteProvider = async (req: Request, res: Response) => {
  try {
    await shippingProviderService.deleteProvider(req.params.id);
    res.json({ message: "Provider deleted" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};

// Activate provider (only one can be active)
export const activateProvider = async (req: Request, res: Response) => {
  try {
    const provider = await shippingProviderService.activateProvider(req.params.id);
    res.json(provider);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
export const deactivateProvider = async (req: Request, res: Response) => {
  try {
    const provider = await shippingProviderService.deactivateProvider(req.params.id);
    res.json(provider);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
};
