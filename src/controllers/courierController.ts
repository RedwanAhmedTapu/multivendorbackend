import type { Request, Response } from "express";
import { courierService } from "../services/CourierServiceManager.ts";
import { formatError } from "../utils/errorFormatter.ts";
import { createOrderSchema } from "../utils/validation.ts";

export const createOrder = async (req: Request, res: Response) => {
  try {
    const parsed = createOrderSchema.parse(req.body); // validate input
    const result = await courierService.createShippingOrder(parsed.provider, parsed);
    res.json({ success: true, order: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: formatError(error) });
  }
};

export const calculateCost = async (req: Request, res: Response) => {
  try {
    const { provider, ...packageData } = req.body;
    const result = await courierService.calculateDeliveryCost(provider, packageData);
    res.json({ success: true, cost: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: formatError(error) });
  }
};

export const trackOrder = async (req: Request, res: Response) => {
  try {
    const { provider, trackingId } = req.params;
    const result = await courierService.trackShippingOrder(provider, trackingId);
    res.json({ success: true, tracking: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: formatError(error) });
  }
};

export const batchTrackOrders = async (req: Request, res: Response) => {
  try {
    const { provider, trackingIds } = req.body;
    const result = await courierService.batchTrackOrders(provider, trackingIds);
    res.json({ success: true, results: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: formatError(error) });
  }
};

/**
 * ✅ Get all cities (works for Pathao & RedX if supported)
 */
export const getCities = async (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const service = await courierService.getService(provider);

    if (!service.getCities) {
      return res.status(400).json({
        success: false,
        error: { message: `getCities not supported for ${provider}` },
      });
    }

    const result = await service.getCities();
    res.json({ success: true, cities: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: formatError(error) });
  }
};

/**
 * ✅ Get all zones by cityId
 */
export const getZones = async (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const cityId = req.query.cityId ? Number(req.query.cityId) : undefined;
    const service = await courierService.getService(provider);

    if (!service.getZones) {
      return res.status(400).json({
        success: false,
        error: { message: `getZones not supported for ${provider}` },
      });
    }

    const result = await service.getZones(cityId);
    res.json({ success: true, zones: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: formatError(error) });
  }
};

/**
 * ✅ Get all areas (requires zoneId for Pathao)
 */
export const getAreas = async (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    console.log(req.query.zoneId)
    const filters = {
      zoneId: req.query.zoneId ? Number(req.query.zoneId) : undefined,
      postCode: req.query.postCode ? Number(req.query.postCode) : undefined,
      districtName: req.query.districtName?.toString(),
    };

    const result = await courierService.getAvailableAreas(provider, filters);
    res.json({ success: true, areas: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: formatError(error) });
  }
};
export const getBalance = async (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const result = await courierService.getProviderBalance(provider);
    res.json({ success: true, balance: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: formatError(error) });
  }
};

export const getStores = async (req: Request, res: Response) => {
  try {
    const { provider } = req.params;
    const result = await courierService.getPickupStores(provider);
    res.json({ success: true, stores: result });
  } catch (error: any) {
    res.status(400).json({ success: false, error: formatError(error) });
  }
};
/**
 * ⚡ OPTIMIZED: Get all locations with proper rate limiting and sequential processing
 */
export const getAllAtOnceZoneAreaCity = async (req: Request, res: Response) => {
  try {
    const { provider } = req.params;

    // Step 1️⃣ — Get cities
    const service = await courierService.getService(provider);
    const cities = await service.getCities();

    console.log(`🏙️ Total cities: ${cities.length}`);
    
    // Step 2️⃣ — Process cities SEQUENTIALLY with delays to avoid rate limiting
    const allData = [];
    let processedCities = 0;
    let totalZones = 0;
    let totalAreas = 0;

    for (const city of cities) {
      try {
        console.log(`🔄 [${++processedCities}/${cities.length}] Processing city: ${city.city_name} (ID: ${city.city_id})`);
        
        let zones = [];
        try {
          // Add delay between city requests
          if (processedCities > 1) {
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second between cities
          }
          
          zones = await service.getZones(city.city_id);
          console.log(`✅ Got ${zones.length} zones for ${city.city_name}`);
        } catch (zoneError: any) {
          console.error(`❌ Error getting zones for city ${city.city_id}:`, zoneError.message);
          
          if (zoneError.response?.status === 429) {
            console.log(`⏳ Rate limited, waiting 5 seconds...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
            // Retry once after waiting
            try {
              zones = await service.getZones(city.city_id);
              console.log(`✅ Retry successful: Got ${zones.length} zones for ${city.city_name}`);
            } catch (retryError) {
              console.error(`❌ Retry failed for city ${city.city_id}`);
              zones = [];
            }
          } else {
            zones = [];
          }
        }

        // Step 3️⃣ — Process zones with delays
        const zoneData = [];
        let processedZones = 0;
        
        for (const zone of zones) {
          try {
            console.log(`   🔄 [${++processedZones}/${zones.length}] Processing zone: ${zone.zone_name} (ID: ${zone.zone_id})`);
            
            // Add delay between zone requests
            if (processedZones > 1) {
              await new Promise(resolve => setTimeout(resolve, 500)); // 500ms between zones
            }
            
            const areas = await service.getAreas({ zoneId: zone.zone_id });
            totalAreas += areas.length;
            
            zoneData.push({
              zone_id: zone.zone_id,
              zone_name: zone.zone_name,
              areas: areas.map((area: any) => ({
                area_id: area.area_id,
                area_name: area.area_name,
                home_delivery_available: area.home_delivery_available,
                pickup_available: area.pickup_available,
              })),
            });
          } catch (areaError: any) {
            console.error(`❌ Error getting areas for zone ${zone.zone_id}:`, areaError.message);
            
            if (areaError.response?.status === 429) {
              console.log(`   ⏳ Rate limited on areas, waiting 3 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 3000));
              // Retry once
              try {
                const areas = await service.getAreas({ zoneId: zone.zone_id });
                totalAreas += areas.length;
                zoneData.push({
                  zone_id: zone.zone_id,
                  zone_name: zone.zone_name,
                  areas: areas.map((area: any) => ({
                    area_id: area.area_id,
                    area_name: area.area_name,
                    home_delivery_available: area.home_delivery_available,
                    pickup_available: area.pickup_available,
                  })),
                });
                console.log(`   ✅ Area retry successful for zone ${zone.zone_name}`);
              } catch (retryError) {
                zoneData.push({
                  zone_id: zone.zone_id,
                  zone_name: zone.zone_name,
                  areas: [],
                  error: 'Rate limit exceeded after retry'
                });
              }
            } else {
              zoneData.push({
                zone_id: zone.zone_id,
                zone_name: zone.zone_name,
                areas: [],
                error: areaError.message
              });
            }
          }
        }

        totalZones += zones.length;
        
        allData.push({
          city_id: city.city_id,
          city_name: city.city_name.trim(),
          zones: zoneData,
        });

        console.log(`📊 Progress: ${processedCities}/${cities.length} cities, ${totalZones} zones, ${totalAreas} areas`);
        
      } catch (error: any) {
        console.error(`❌ Error processing city ${city.city_id}:`, error.message);
        allData.push({
          city_id: city.city_id,
          city_name: city.city_name.trim(),
          zones: [],
          error: error.message
        });
      }
    }

    // Calculate final statistics
    const successfulCities = allData.filter(city => !city.error && city.zones.length > 0).length;
    
    console.log(`🎉 Completed! Processed ${successfulCities}/${cities.length} cities successfully`);
    console.log(`📊 Final Stats: ${totalZones} zones, ${totalAreas} areas`);

    // Step 4️⃣ — Return structured data
    res.json({ 
      success: true, 
      data: allData,
      stats: {
        total_cities: cities.length,
        successful_cities: successfulCities,
        total_zones: totalZones,
        total_areas: totalAreas,
        success_rate: `${((successfulCities / cities.length) * 100).toFixed(1)}%`
      }
    });
  } catch (error: any) {
    console.error("❌ Error in getAllAtOnceZoneAreaCity:", error);
    res.status(500).json({ success: false, error: formatError(error) });
  }
};