import fs from "fs";
import path from "path";

const modulesDir = path.join(process.cwd(), "prisma/modules");
const outputFile = path.join(process.cwd(), "prisma/schema.prisma");

let schema = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
`;

fs.readdirSync(modulesDir).forEach(file => {
  if (file.endsWith(".prisma")) {
    const content = fs.readFileSync(path.join(modulesDir, file), "utf-8");
    schema += "\n" + content;
  }
});

fs.writeFileSync(outputFile, schema);
console.log("✅ Prisma schema merged into schema.prisma");
