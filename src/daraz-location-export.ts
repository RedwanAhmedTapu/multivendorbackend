import puppeteer, { Page } from "puppeteer";
import * as XLSX from "xlsx";
import * as fs from "fs";

interface Location {
  id: string;
  name: string;
  parentId?: string;
  level: string;
  division?: string;
  district?: string;
}

// Helper function for delays (replaces deprecated page.waitForTimeout)
const delay = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms));

async function scrapeFromCheckout() {
  console.log("🚀 Daraz Location Scraper - Manual Method\n");
  console.log("This script captures API calls while you browse!\n");
  
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
  });

  const page: Page = await browser.newPage();
  
  const allLocations: Location[] = [];
  const seenIds = new Set<string>();
  
  // Intercept all location API responses
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('getSubAddressList') || url.includes('location')) {
      try {
        const data = await response.json();
        if (data.module && Array.isArray(data.module)) {
          const urlPart = url.split('addressId=')[1] || 'root';
          console.log(`📦 Captured ${data.module.length} locations (${urlPart.substring(0, 20)}...)`);
          
          data.module.forEach((item: any) => {
            if (!seenIds.has(item.id)) {
              seenIds.add(item.id);
              allLocations.push({
                id: item.id,
                name: item.name,
                parentId: item.parentId,
                level: item.scope || item.level,
              });
            }
          });
        }
      } catch (e) {
        // Not JSON, ignore
      }
    }
  });
  
  try {
    console.log("🌐 Opening Daraz...");
    await page.goto("https://www.daraz.com.bd", { 
      waitUntil: "networkidle2",
      timeout: 60000 
    });
    
    await delay(3000);
    
    console.log("\n═══════════════════════════════════════════════════════");
    console.log("📋 INSTRUCTIONS:");
    console.log("═══════════════════════════════════════════════════════");
    console.log("1. In the browser window that just opened:");
    console.log("   → Go to 'My Account' → 'Addresses'");
    console.log("   → OR go to any checkout page");
    console.log("");
    console.log("2. Find the location dropdown selectors:");
    console.log("   → Division/Region");
    console.log("   → District/City");
    console.log("   → Thana/Upazila/Area");
    console.log("");
    console.log("3. Click through DIFFERENT locations:");
    console.log("   → Select different divisions");
    console.log("   → Select different districts");
    console.log("   → Select different thanas");
    console.log("");
    console.log("4. Take your time - browse as many as you want");
    console.log("   → The script captures ALL API calls automatically");
    console.log("   → You'll see 📦 messages for each capture");
    console.log("");
    console.log("5. When finished, just wait for the timer");
    console.log("═══════════════════════════════════════════════════════");
    console.log("\n⏳ Timer: 5 minutes (300 seconds)");
    console.log("📊 Locations captured so far: 0\n");
    
    // Progress tracker
    const startTime = Date.now();
    const totalTime = 300000; // 5 minutes
    
    const progressInterval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.ceil((totalTime - elapsed) / 1000);
      
      if (remaining > 0 && remaining % 30 === 0) {
        const minutes = Math.floor(remaining / 60);
        const seconds = remaining % 60;
        console.log(`\n⏱️  ${minutes}:${seconds.toString().padStart(2, '0')} remaining | Total captured: ${allLocations.length}`);
      }
    }, 1000);
    
    // Wait for 5 minutes
    await delay(totalTime);
    clearInterval(progressInterval);
    
    console.log("\n\n⏰ Time's up! Processing captured data...");
    
    const uniqueLocations = Array.from(allLocations);
    
    console.log(`\n📊 RESULTS:`);
    console.log(`   Total locations captured: ${uniqueLocations.length}`);
    
    if (uniqueLocations.length === 0) {
      console.log("\n❌ No locations were captured!");
      console.log("\n💡 Possible reasons:");
      console.log("   1. You didn't navigate to address/checkout page");
      console.log("   2. You didn't click on location dropdowns");
      console.log("   3. The API endpoint is different");
      console.log("   4. You're not logged in (may be required)");
      
      console.log("\n📸 Taking screenshot for debugging...");
      await page.screenshot({ path: 'debug_screenshot.png', fullPage: true });
      console.log("   Screenshot saved: debug_screenshot.png");
      
      const currentUrl = page.url();
      console.log(`   Current URL: ${currentUrl}`);
      
      return;
    }
    
    // Statistics by level
    const byLevel: Record<string, Location[]> = {};
    uniqueLocations.forEach(loc => {
      if (!byLevel[loc.level]) {
        byLevel[loc.level] = [];
      }
      byLevel[loc.level].push(loc);
    });
    
    console.log("\n📈 Breakdown by level:");
    Object.keys(byLevel).sort().forEach(level => {
      const levelNames: Record<string, string> = {
        'L2': 'Divisions',
        'L3': 'Districts',
        'L4': 'Thanas/Upazilas',
        'L5': 'Areas'
      };
      const name = levelNames[level] || level;
      console.log(`   ${level} (${name}): ${byLevel[level].length}`);
    });
    
    // Save all formats
    console.log("\n💾 Saving data to files...");
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    
    // Excel
    const worksheet = XLSX.utils.json_to_sheet(uniqueLocations);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Locations");
    const excelFile = `daraz_locations_${timestamp}.xlsx`;
    XLSX.writeFile(workbook, excelFile);
    console.log(`   ✅ Excel: ${excelFile}`);
    
    // JSON
    const jsonFile = 'daraz_locations.json';
    fs.writeFileSync(jsonFile, JSON.stringify(uniqueLocations, null, 2));
    console.log(`   ✅ JSON: ${jsonFile}`);
    
    // CSV
    const csvContent = [
      ['ID', 'Name', 'Parent ID', 'Level'].join(','),
      ...uniqueLocations.map(loc => 
        [
          loc.id,
          `"${loc.name.replace(/"/g, '""')}"`,
          loc.parentId || '',
          loc.level
        ].join(',')
      )
    ].join('\n');
    const csvFile = 'daraz_locations.csv';
    fs.writeFileSync(csvFile, csvContent);
    console.log(`   ✅ CSV: ${csvFile}`);
    
    console.log("\n✨ All done! Files saved successfully.");
    console.log("\n📝 Note:");
    console.log("   This captured only the locations you clicked through.");
    console.log("   To get ALL locations, you'd need to click every option.");
    console.log("   Or run multiple sessions and merge the data.");

  } catch (error) {
    console.error("\n💥 Error:", error);
    
    // Save partial data
    if (allLocations.length > 0) {
      console.log(`\n💾 Saving ${allLocations.length} locations captured before error...`);
      fs.writeFileSync('daraz_locations_partial.json', JSON.stringify(allLocations, null, 2));
      console.log("   Saved to: daraz_locations_partial.json");
    }
  } finally {
    console.log("\n⏸️ Browser will close in 10 seconds...");
    await delay(10000);
    await browser.close();
  }
}

// Run the script
scrapeFromCheckout()
  .then(() => {
    console.log("\n✨ Script completed successfully");
    process.exit(0);
  })
  .catch((error) => {
    console.error("\n💥 Script failed:", error);
    process.exit(1);
  });