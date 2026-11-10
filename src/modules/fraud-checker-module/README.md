# fraud-checker module

সম্পূর্ণ self-contained module — এই পুরো ফোল্ডারটা কপি করে আপনার প্রজেক্টে
`src/modules/fraud-checker/` (বা আপনার পছন্দের path) এ বসিয়ে দিলেই কাজ শুরু করা যায়।

## Folder structure

```
fraud-checker/
  index.ts                              ← barrel export — বাইরের কোড এখান থেকেই import করবে
  types.ts                              ← IFraudCheckerAdapter contract
  credential-cipher.ts                  ← AES-256-GCM encrypt/decrypt/mask
  fraud-checker.service.ts              ← runtime: active providers priority অনুযায়ী try/fallback/log
  providers/
    nirvor.provider.ts                  ← Nirvor.app adapter
    fraudbd.provider.ts                 ← FraudBD.com adapter
    registry.ts                         ← slug → adapter mapping (নতুন provider এখানে যোগ হয়)
  admin/
    fraud-provider.admin.service.ts     ← CRUD, encrypt on write, mask on read
    fraud-provider.admin.controller.ts  ← express handlers
    fraud-provider.admin.routes.ts      ← mount at /admin-fraud-providers
  prisma/
    fraud-checker.schema.prisma         ← আপনার main schema.prisma এ merge করার জন্য
  admin-ui/
    adminFraudProviderApi.ts            ← Admin panel RTK Query slice (list/create/toggle/test/logs)
```

## Setup (৩ ধাপ)

1. **এই পুরো ফোল্ডার** আপনার প্রজেক্টে বসান, যেমন:
   ```
   src/modules/fraud-checker/
   ```
2. **Schema merge**: `prisma/fraud-checker.schema.prisma` এর মডেলগুলো main `schema.prisma` তে কপি করুন,
   আর `User` model এ এই একলাইন যোগ করুন (schema তে কমেন্টে বিস্তারিত আছে):
   ```prisma
   createdFraudProviders FraudCheckerProvider[] @relation("FraudProviderCreator")
   ```
   তারপর:
   ```
   npx prisma format
   npx prisma db push
   ```
3. **Env + routes**:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   # .env → FRAUD_CRED_ENCRYPTION_KEY=<generated hex>
   ```
   `admin/fraud-provider.admin.routes.ts` এর `authenticateAdmin` import path আপনার প্রজেক্ট
   অনুযায়ী ঠিক করুন, তারপর app-level এ mount করুন (আপনার `/admin-orders`, `/user-orders`
   এর সাথে naming মিলিয়ে):
   ```ts
   import fraudProviderRoutes from "./modules/fraud-checker/admin/fraud-provider.admin.routes.ts";
   app.use("/admin-fraud-providers", fraudProviderRoutes);
   ```

## ব্যবহার (অন্য কোথাও থেকে import)

মডিউলের ভেতরের ফাইল সরাসরি import না করে সবসময় `index.ts` থেকে import করুন:

```ts
import { fraudCheckerService } from "./modules/fraud-checker/index.ts";

const result = await fraudCheckerService.checkPhone("01712345678").catch(() => null);
```

## নতুন Provider যোগ করা

1. `providers/<slug>.provider.ts` — `nirvor.provider.ts` কপি করে সেই API এর জন্য লিখুন।
2. `providers/registry.ts` তে ১ লাইন import + `ADAPTERS` array এ যোগ করুন।
3. Admin panel থেকে `GET /admin/fraud-providers/available` এ নতুন adapter দেখা যাবে →
   credentials সহ create করুন → `isActive: true`।

## Provider বাদ দেওয়া

`PATCH /admin/fraud-providers/:id/active { isActive: false }` অথবা `DELETE` — কোনো deploy লাগে না।

## Order flow এ hook (আবশ্যিক অংশ, ঐচ্ছিক ব্যবহার)

`order.service.ts` এর `placeOrder()` এ risk scoring যেখানে raw `prisma` client
দিয়ে `tx` শুরুর আগে হয়, ঠিক সেখানে বসবে:

```ts
import { fraudCheckerService } from "../modules/fraud-checker/index.ts";

const fraudResult = await fraudCheckerService.checkPhone(address.phone).catch(() => null);
const riskScore = OrderService.calculateRiskScore(user, subtotal, address, fraudResult);
```

`calculateRiskScore` এ একটা `fraudResult?: NormalizedFraudCheckResult | null` প্যারামিটার
যোগ করে `riskLevel` অনুযায়ী স্কোর অ্যাডজাস্ট করুন। `.catch(() => null)` জরুরি — fraud check
optional সিগন্যাল, কোনো provider active না থাকলে বা fail করলেও order flow block হবে না।

## Admin UI (RTK Query)

`admin-ui/adminFraudProviderApi.ts` — আপনার `adminOrderApi.ts` এর একই প্যাটার্নে লেখা
RTK Query slice, provider list/create/update/toggle/delete/test-connection/logs এর জন্য।

**Setup:**
1. ফাইলটা আপনার frontend এর `features/` ফোল্ডারে কপি করুন।
2. Redux store এ reducer + middleware যোগ করুন (অন্য api slice গুলোর পাশে):
   ```ts
   import { adminFraudProviderApi } from "./features/adminFraudProviderApi";

   // reducer:
   [adminFraudProviderApi.reducerPath]: adminFraudProviderApi.reducer,
   // middleware:
   .concat(adminFraudProviderApi.middleware)
   ```
3. Backend route **অবশ্যই** `/admin-fraud-providers` তে mount করুন (এই slice এই path গুলোই call করে,
   `admin/fraud-provider.admin.routes.ts` এর কমেন্টে বিস্তারিত আছে):
   ```ts
   app.use("/admin-fraud-providers", fraudProviderRoutes);
   ```

**সাধারণ ব্যবহার (Add Provider ফর্ম):**
```tsx
const { data: available } = useGetAvailableFraudAdaptersQuery();
// available.data = [{ slug: "nirvor", displayName: "...", credentialFields: [...], alreadyConfigured: false }, ...]
// ড্রপডাউনে দেখান, adapter বেছে নিলে credentialFields দিয়ে ফর্ম বানান

const [createProvider] = useCreateFraudProviderMutation();
await createProvider({
  slug: "nirvor",
  name: "Nirvor.app",
  credentials: { apiKey: "...", apiSecret: "..." },
  isActive: true,
  priority: 0,
});
```

**Toggle on/off:**
```tsx
const [setActive] = useSetFraudProviderActiveMutation();
await setActive({ id: provider.id, isActive: !provider.isActive });
```

## Security

- Raw API key/secret কখনো plaintext এ DB তে যায় না — `encryptCredentials()` দিয়ে AES-256-GCM এনক্রিপ্টেড।
- Admin panel এ কখনো decrypted secret ফেরত যায় না — শুধু `maskCredentials()` এর masked ভিউ।
- Decryption শুধু `FraudCheckerService` এর ভিতরে, request-lifetime এ মেমোরিতে হয়, persist হয় না।
- Key rotate করতে `credential-cipher.ts` এর `rotateKeyReencrypt()` দিয়ে one-off script লিখুন।
