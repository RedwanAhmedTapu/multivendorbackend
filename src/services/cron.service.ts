import { PayoutService } from './payout.service';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();


const payoutService = new PayoutService();

export class CronService {
  async runWeeklyPayouts() {
    try {
      const activeVendors = await prisma.vendor.findMany({
        where: { status: 'ACTIVE' }
      });

      for (const vendor of activeVendors) {
        try {
          await payoutService.processVendorPayouts(vendor.id, 'weekly');
          console.log(`Weekly payout processed for vendor: ${vendor.storeName}`);
        } catch (error) {
          console.error(`Failed to process payout for vendor ${vendor.id}:`, error);
        }
      }
    } catch (error) {
      console.error('Weekly payout cron job failed:', error);
    }
  }

  async runDailyPayouts() {
    // Similar implementation for daily payouts
  }

  async runMonthlyPayouts() {
    // Similar implementation for monthly payouts
  }
}