const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, getDocs, collection, updateDoc } = require('firebase/firestore');

const projectId = 'demo-cwb-security-rules';
let environment;

test.before(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: process.env.FIRESTORE_EMULATOR_HOST?.split(':')[0] || '127.0.0.1',
      port: Number(process.env.FIRESTORE_EMULATOR_HOST?.split(':')[1] || 8085),
      rules: readFileSync(join(__dirname, '..', '..', 'firestore.rules'), 'utf8')
    }
  });

  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await db.doc('boats/70b3d57ed0000001').set({
      device_id: '70b3d57ed0000001',
      vessel_name: 'Test Boat',
      boat_type: 'Row',
      availability_status: 'available',
      report_interval_minutes: 3,
      schedule_year: 2026,
      rental_season_start: '03-15',
      rental_season_end: '10-15',
      rental_schedule: {},
      tracking_enabled: false,
      booked: false
    });
    await db.doc('users/user-1').set({ email: 'user-1@cwb.org', role: 'staff' });
    await db.doc('users/user-2').set({ email: 'user-2@cwb.org', role: 'staff' });
  });
});

test.after(async () => environment?.cleanup());

function authenticatedDb(uid, token = {}) {
  return environment.authenticatedContext(uid, token).firestore();
}

test('anonymous and unassigned users cannot read operational data', async () => {
  await assertFails(getDoc(doc(environment.unauthenticatedContext().firestore(), 'boats/70b3d57ed0000001')));
  await assertFails(getDoc(doc(authenticatedDb('unassigned'), 'boats/70b3d57ed0000001')));
});

test('assigned operations roles can read operational data', async () => {
  for (const role of ['manager', 'staff', 'volunteer']) {
    const db = authenticatedDb(`${role}-1`, { role, functionLevel: 'operations' });
    await assertSucceeds(getDoc(doc(db, 'boats/70b3d57ed0000001')));
  }
});

test('rental updates require an operations role and TOTP', async () => {
  const update = { availability_status: 'rented', tracking_enabled: true, booked: true };
  const staffWithoutMfa = authenticatedDb('staff-1', { role: 'staff', functionLevel: 'operations' });
  await assertFails(updateDoc(doc(staffWithoutMfa, 'boats/70b3d57ed0000001'), update));

  const staffWithMfa = authenticatedDb('staff-1', {
    role: 'staff',
    functionLevel: 'operations',
    firebase: { sign_in_second_factor: 'totp' }
  });
  await assertSucceeds(updateDoc(doc(staffWithMfa, 'boats/70b3d57ed0000001'), update));
});

test('users can read only their own profile while MFA admins can list users', async () => {
  const userDb = authenticatedDb('user-1', { role: 'staff', functionLevel: 'operations' });
  await assertSucceeds(getDoc(doc(userDb, 'users/user-1')));
  await assertFails(getDoc(doc(userDb, 'users/user-2')));
  await assertFails(getDocs(collection(userDb, 'users')));

  const adminDb = authenticatedDb('admin-1', {
    admin: true,
    role: 'admin',
    firebase: { sign_in_second_factor: 'totp' }
  });
  const result = await assertSucceeds(getDocs(collection(adminDb, 'users')));
  assert.equal(result.size, 2);
});