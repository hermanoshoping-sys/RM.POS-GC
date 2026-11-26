import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  accountsDb,
  authenticateAccountUser,
  createStaffUserInActiveAccount,
  listRegisteredAccounts,
  registerNewAccount,
} from '../accountsDb';
import { DEFAULT_LEGACY_DB_NAME, db, switchActiveTenantDatabase } from '../database';
import * as ops from '../operations';
import {
  deriveActivationCodeForLicense,
  generateLicensePair,
  verifyLicenseActivationPair,
} from '../../utils/license';

async function clearAllTestDbs() {
  const existing = await accountsDb.accounts.toArray();
  for (const acc of existing) {
    await switchActiveTenantDatabase(acc.dbName);
    await db.delete();
  }
  await switchActiveTenantDatabase(DEFAULT_LEGACY_DB_NAME);
  await db.delete();
  await accountsDb.delete();
  await accountsDb.open();
}

describe('Multi-Account Registration, Licensing, Email/Phone Auth & Tenant Isolation', () => {
  beforeEach(async () => {
    await clearAllTestDbs();
  });

  it('validates license number and cryptographic activation code pairs and rejects mismatches or reuse', async () => {
    const pair = await generateLicensePair();
    expect(pair.licenseNumber).toMatch(/^RMGC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(pair.activationCode).toMatch(/^ACT-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(await verifyLicenseActivationPair(pair.licenseNumber, pair.activationCode)).toBe(true);
    expect(await verifyLicenseActivationPair(pair.licenseNumber, 'ACT-0000-0000')).toBe(false);

    // Registration with mismatched activation code must fail
    await expect(
      registerNewAccount({
        storeName: 'متجر خطأ',
        ownerName: 'أمين',
        email: 'bad@store.ma',
        password: 'Password123',
        licenseNumber: pair.licenseNumber,
        activationCode: 'ACT-ZZZZ-ZZZZ',
        currency: 'MAD',
        defaultLanguage: 'ar',
        loadDemoData: false,
      })
    ).rejects.toThrow();

    // Registration with valid license + activation code succeeds
    const { account } = await registerNewAccount({
      storeName: 'متجر الأطلس',
      ownerName: 'أمين',
      email: 'atlas@store.ma',
      password: 'Password123',
      licenseNumber: pair.licenseNumber,
      activationCode: pair.activationCode,
      currency: 'MAD',
      defaultLanguage: 'ar',
      loadDemoData: false,
    });
    expect(account.licenseNumber).toBe(pair.licenseNumber);
    expect(account.licenseStatus).toBe('active');

    // Reusing the same license number for a second account must fail
    await expect(
      registerNewAccount({
        storeName: 'متجر مكرر',
        ownerName: 'يوسف',
        email: 'other@store.ma',
        password: 'Password123',
        licenseNumber: pair.licenseNumber,
        activationCode: pair.activationCode,
        currency: 'MAD',
        defaultLanguage: 'ar',
        loadDemoData: false,
      })
    ).rejects.toThrow();
  });

  it('supports creating independent accounts with email or phone, authenticates by either, and strictly isolates data', async () => {
    const licA = await generateLicensePair();
    const licB = await generateLicensePair();

    // Account A: Email + Phone
    const resA = await registerNewAccount({
      storeName: 'سوبر مارشي الأطلس',
      ownerName: 'عمر المدير',
      email: 'omar@atlas.ma',
      phone: '+212 661-111-111',
      password: 'AtlasPassword1',
      licenseNumber: licA.licenseNumber,
      activationCode: licA.activationCode,
      currency: 'MAD',
      defaultLanguage: 'ar',
      loadDemoData: false,
    });

    // Add a product strictly inside Account A
    await ops.createProductWithOpeningStock(
      {
        name: 'منتج خاص بالأطلس',
        sku: 'ATL-01',
        barcode: '9990001',
        categoryId: null,
        unit: 'علبة',
        purchasePrice: 10,
        salePrice: 20,
        wholesalePrice: 18,
        secondSalePrice: 19,
        quantity: 25,
        minStock: 2,
        isActive: true,
        isWeighted: false,
      },
      resA.adminUser
    );
    expect(await db.products.count()).toBe(1);

    // Account B: Phone ONLY (no email)
    const resB = await registerNewAccount({
      storeName: 'متجر النور',
      ownerName: 'سلمى المديرة',
      phone: '0662222222',
      password: 'NourPassword2',
      licenseNumber: licB.licenseNumber,
      activationCode: licB.activationCode,
      currency: 'MAD',
      defaultLanguage: 'fr',
      loadDemoData: false,
    });

    // Account B MUST have its own isolated DB with 0 products from Account A
    expect(resB.account.dbName).not.toBe(resA.account.dbName);
    expect(await db.products.count()).toBe(0);
    expect((await db.settings.get(1))?.storeInfo.storeName).toBe('متجر النور');

    // Authenticate into Account A by EMAIL -> sees Account A's product
    const authEmailA = await authenticateAccountUser({
      identifier: 'OMAR@ATLAS.MA',
      password: 'AtlasPassword1',
    });
    expect(authEmailA.account.accountId).toBe(resA.account.accountId);
    expect(await db.products.count()).toBe(1);
    expect((await db.products.toArray())[0].name).toBe('منتج خاص بالأطلس');

    // Authenticate into Account B by PHONE -> sees 0 products
    const authPhoneB = await authenticateAccountUser({
      identifier: '0662 22 22 22',
      password: 'NourPassword2',
    });
    expect(authPhoneB.account.accountId).toBe(resB.account.accountId);
    expect(await db.products.count()).toBe(0);

    // Authenticate into Account A by PHONE (formatted) -> succeeds
    const authPhoneA = await authenticateAccountUser({
      identifier: '+212 661 111 111',
      password: 'AtlasPassword1',
    });
    expect(authPhoneA.account.accountId).toBe(resA.account.accountId);

    // Wrong password must fail
    await expect(
      authenticateAccountUser({
        identifier: 'omar@atlas.ma',
        password: 'WrongPassword',
      })
    ).rejects.toThrow();

    expect((await listRegisteredAccounts()).length).toBe(2);
  });

  it('supports isolated staff users per account who sign in with email, phone, or username', async () => {
    const lic1 = 'RMGC-AB12-CD34-EF56';
    const act1 = await deriveActivationCodeForLicense(lic1);
    const lic2 = await generateLicensePair();

    const acc1 = await registerNewAccount({
      storeName: 'متجر 1',
      ownerName: 'مدير 1',
      email: 'owner1@shop.ma',
      password: 'Owner1Password',
      licenseNumber: lic1,
      activationCode: act1,
      currency: 'MAD',
      defaultLanguage: 'ar',
      loadDemoData: false,
    });

    // Admin of Account 1 creates a cashier inside Account 1
    const cashier1 = await createStaffUserInActiveAccount(
      acc1.account.accountId,
      {
        username: 'said_pos',
        fullName: 'سعيد البائع',
        email: 'said@shop.ma',
        phone: '0677889900',
        role: 'cashier',
        password: 'CashierPassword1',
      },
      acc1.adminUser
    );
    expect(cashier1.role).toBe('cashier');
    expect(cashier1.permissions.canManageSettings).toBe(false);

    // Create Account 2 with its own staff user
    const acc2 = await registerNewAccount({
      storeName: 'متجر 2',
      ownerName: 'مدير 2',
      email: 'owner2@shop.ma',
      password: 'Owner2Password',
      licenseNumber: lic2.licenseNumber,
      activationCode: lic2.activationCode,
      currency: 'MAD',
      defaultLanguage: 'ar',
      loadDemoData: false,
    });

    // Account 2 must NOT see Account 1's cashier
    expect(await db.users.count()).toBe(1);

    // Cashier from Account 1 logs in via EMAIL -> routed strictly to Account 1
    const staffEmailAuth = await authenticateAccountUser({
      identifier: 'said@shop.ma',
      password: 'CashierPassword1',
    });
    expect(staffEmailAuth.account.accountId).toBe(acc1.account.accountId);
    expect(staffEmailAuth.user.username).toBe('said_pos');
    expect(staffEmailAuth.user.permissions.canManageSettings).toBe(false);

    // Cashier from Account 1 logs in via PHONE -> routed strictly to Account 1
    const staffPhoneAuth = await authenticateAccountUser({
      identifier: '0677-88-99-00',
      password: 'CashierPassword1',
    });
    expect(staffPhoneAuth.account.accountId).toBe(acc1.account.accountId);
    expect(staffPhoneAuth.user.username).toBe('said_pos');

    // Cashier from Account 1 CANNOT log into Account 2
    await expect(
      authenticateAccountUser({
        identifier: 'said@shop.ma',
        password: 'CashierPassword1',
        preferredAccountId: acc2.account.accountId,
      })
    ).rejects.toThrow();
  });
});
