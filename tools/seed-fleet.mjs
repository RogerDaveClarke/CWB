#!/usr/bin/env node
// Seed the CWB fleet of 11 rowboats and initial rental history into Firestore
// Usage: node tools/seed-fleet.mjs

import { loadEnv } from "./load-env.mjs";

const env = loadEnv("../local.env");
const projectId = env.FIREBASE_PROJECT_ID || "cwb-boat-operations-c50dd";

const { initializeApp, cert, applicationDefault } = await import("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = await import("firebase-admin/firestore");

const credential = env.GOOGLE_APPLICATION_CREDENTIALS ? cert(env.GOOGLE_APPLICATION_CREDENTIALS) : applicationDefault();
initializeApp({ credential, projectId });

const db = getFirestore();

const DOCK = { latitude: 47.62795, longitude: -122.33645 };
const now = new Date();

const defaultSchedule = {
  monday: { enabled: false, start: "12:30", end: "18:30" },
  tuesday: { enabled: true, start: "12:30", end: "18:30" },
  wednesday: { enabled: true, start: "12:30", end: "18:30" },
  thursday: { enabled: true, start: "12:30", end: "18:30" },
  friday: { enabled: true, start: "12:30", end: "18:30" },
  saturday: { enabled: true, start: "12:30", end: "18:30" },
  sunday: { enabled: true, start: "12:30", end: "18:30" }
};

const fleet = [
  {
    id: "70b3d57ed0000001",
    vessel_name: "Rowboat Martha",
    boat_type: "Row",
    availability_status: "available",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: false,
    booked_by: "",
    last_ping: {
      protocol_version: 1,
      latitude: 47.62805,
      longitude: -122.33638,
      battery_mv: 5160,
      low_battery: false,
      gps_fix: true,
      mooring_status: "Tied Up at Dock",
      variance_g2: 0.0004,
      max_temperature_c: 18.2,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 2 * 60000))
    }
  },
  {
    id: "70b3d57ed0000002",
    vessel_name: "Rowboat Colleen",
    boat_type: "Row",
    availability_status: "available",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: false,
    booked_by: "",
    last_ping: {
      protocol_version: 1,
      latitude: 47.62812,
      longitude: -122.33628,
      battery_mv: 5010,
      low_battery: false,
      gps_fix: true,
      mooring_status: "Tied Up at Dock",
      variance_g2: 0.0005,
      max_temperature_c: 18.1,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 3 * 60000))
    }
  },
  {
    id: "70b3d57ed0000003",
    vessel_name: "Rowboat Virginia V",
    boat_type: "Row",
    availability_status: "available",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: false,
    booked_by: "",
    last_ping: {
      protocol_version: 1,
      latitude: 47.62792,
      longitude: -122.33651,
      battery_mv: 4930,
      low_battery: false,
      gps_fix: true,
      mooring_status: "Tied Up at Dock",
      variance_g2: 0.0004,
      max_temperature_c: 18.4,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 4 * 60000))
    }
  },
  {
    id: "70b3d57ed0000004",
    vessel_name: "Rowboat Blanchard",
    boat_type: "Row",
    availability_status: "under_repair",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: false,
    booked_by: "",
    last_ping: {
      protocol_version: 1,
      latitude: 47.62786,
      longitude: -122.33662,
      battery_mv: 4090,
      low_battery: true,
      gps_fix: true,
      mooring_status: "Tied Up at Dock",
      variance_g2: 0.0003,
      max_temperature_c: null,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 45 * 60000))
    }
  },
  {
    id: "70b3d57ed0000005",
    vessel_name: "Rowboat Wagner",
    boat_type: "Row",
    availability_status: "available",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: false,
    booked_by: "",
    last_ping: {
      protocol_version: 1,
      latitude: 47.62820,
      longitude: -122.33643,
      battery_mv: 4870,
      low_battery: false,
      gps_fix: true,
      mooring_status: "Tied Up at Dock",
      variance_g2: 0.0006,
      max_temperature_c: 18.2,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 2 * 60000))
    }
  },
  {
    id: "70b3d57ed0000006",
    vessel_name: "Rowboat Dearborn",
    boat_type: "Row",
    availability_status: "available",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: false,
    booked_by: "",
    last_ping: {
      protocol_version: 1,
      latitude: 47.62808,
      longitude: -122.33670,
      battery_mv: 4750,
      low_battery: false,
      gps_fix: true,
      mooring_status: "Tied Up at Dock",
      variance_g2: 0.0005,
      max_temperature_c: 18.7,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 5 * 60000))
    }
  },
  {
    id: "70b3d57ed0000007",
    vessel_name: "Rowboat Cascade",
    boat_type: "Row",
    availability_status: "available",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: false,
    booked_by: "",
    last_ping: {
      protocol_version: 1,
      latitude: 47.62778,
      longitude: -122.33632,
      battery_mv: 5090,
      low_battery: false,
      gps_fix: true,
      mooring_status: "Tied Up at Dock",
      variance_g2: 0.0004,
      max_temperature_c: 19.0,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 1 * 60000))
    }
  },
  {
    id: "70b3d57ed0000008",
    vessel_name: "Rowboat Fremont",
    boat_type: "Row",
    availability_status: "available",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: false,
    booked_by: "",
    last_ping: {
      protocol_version: 1,
      latitude: 47.62826,
      longitude: -122.33612,
      battery_mv: 4960,
      low_battery: false,
      gps_fix: true,
      mooring_status: "Tied Up at Dock",
      variance_g2: 0.0005,
      max_temperature_c: 19.3,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 3 * 60000))
    }
  },
  {
    id: "70b3d57ed0000009",
    vessel_name: "Rowboat Gas Works",
    boat_type: "Row",
    availability_status: "rented",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: true,
    booked_by: "Marcus Lee",
    renter_type: "Public",
    passenger_count: 2,
    rental_type: "open",
    time_out: Timestamp.fromDate(new Date(now.getTime() - 40 * 60000)),
    last_ping: {
      protocol_version: 1,
      latitude: 47.6346,
      longitude: -122.3328,
      battery_mv: 4680,
      low_battery: false,
      gps_fix: true,
      mooring_status: "Underway / Moving",
      variance_g2: 0.0017,
      max_temperature_c: 19.4,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 1 * 60000))
    }
  },
  {
    id: "70b3d57ed0000010",
    vessel_name: "Rowboat Aurora",
    boat_type: "Row",
    availability_status: "rented",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: true,
    booked_by: "Taylor Brooks",
    renter_type: "Volunteer",
    passenger_count: 3,
    rental_type: "fixed",
    rental_minutes: 60,
    time_out: Timestamp.fromDate(new Date(now.getTime() - 25 * 60000)),
    last_ping: {
      protocol_version: 1,
      latitude: 47.6402,
      longitude: -122.3344,
      battery_mv: 4520,
      low_battery: false,
      gps_fix: true,
      mooring_status: "Underway / Moving",
      variance_g2: 0.0028,
      max_temperature_c: 19.2,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 2 * 60000))
    }
  },
  {
    id: "70b3d57ed0000011",
    vessel_name: "Purdy",
    boat_type: "Row",
    availability_status: "available",
    report_interval_minutes: 5,
    schedule_year: now.getFullYear(),
    rental_season_start: `${now.getFullYear()}-04-01`,
    rental_season_end: `${now.getFullYear()}-10-31`,
    rental_schedule: defaultSchedule,
    booked: false,
    booked_by: "",
    last_ping: {
      protocol_version: 1,
      latitude: 47.62815,
      longitude: -122.33635,
      battery_mv: 4890,
      low_battery: false,
      gps_fix: true,
      mooring_status: "Tied Up at Dock",
      variance_g2: 0.0004,
      max_temperature_c: 18.9,
      timestamp: Timestamp.fromDate(new Date(now.getTime() - 1 * 60000))
    }
  }
];

const rentalHistory = [
  {
    boat_id: "70b3d57ed0000001",
    vessel_name: "Rowboat Martha",
    boat_type: "Row",
    renter_name: "Jamie Chen",
    renter_type: "Public",
    passenger_count: 2,
    rental_type: "fixed",
    rental_minutes: 60,
    checked_out_at: Timestamp.fromDate(new Date(now.getTime() - 4 * 3600000)),
    checked_in_at: Timestamp.fromDate(new Date(now.getTime() - 3 * 3600000)),
    duration_minutes: 57,
    dock_action: "Returned on time"
  },
  {
    boat_id: "70b3d57ed0000002",
    vessel_name: "Rowboat Colleen",
    boat_type: "Row",
    renter_name: "Priya Shah",
    renter_type: "Public",
    passenger_count: 4,
    rental_type: "fixed",
    rental_minutes: 60,
    checked_out_at: Timestamp.fromDate(new Date(now.getTime() - 6 * 3600000)),
    checked_in_at: Timestamp.fromDate(new Date(now.getTime() - 5 * 3600000)),
    duration_minutes: 62,
    dock_action: "Returned on time"
  },
  {
    boat_id: "70b3d57ed0000005",
    vessel_name: "Rowboat Wagner",
    boat_type: "Row",
    renter_name: "Noah Williams",
    renter_type: "Volunteer",
    passenger_count: 1,
    rental_type: "fixed",
    rental_minutes: 60,
    checked_out_at: Timestamp.fromDate(new Date(now.getTime() - 24 * 3600000)),
    checked_in_at: Timestamp.fromDate(new Date(now.getTime() - 23 * 3600000)),
    duration_minutes: 56,
    dock_action: "Returned on time"
  },
  {
    boat_id: "70b3d57ed0000006",
    vessel_name: "Rowboat Dearborn",
    boat_type: "Row",
    renter_name: "Amina Yusuf",
    renter_type: "Public",
    passenger_count: 2,
    rental_type: "open",
    checked_out_at: Timestamp.fromDate(new Date(now.getTime() - 28 * 3600000)),
    checked_in_at: Timestamp.fromDate(new Date(now.getTime() - 26.5 * 3600000)),
    duration_minutes: 90,
    dock_action: "Returned"
  }
];

async function seed() {
  console.log(`Seeding fleet data into project ${projectId}...`);
  const batch = db.batch();

  for (const boat of fleet) {
    const docRef = db.collection("boats").doc(boat.id);
    batch.set(docRef, {
      ...boat,
      configuration_updated_at: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  for (const record of rentalHistory) {
    const docRef = db.collection("rental_history").doc();
    batch.set(docRef, record);
  }

  await batch.commit();
  console.log(`Successfully seeded ${fleet.length} boats and ${rentalHistory.length} rental records into Firestore!`);
}

seed().catch(err => {
  console.error("Seeding failed:", err);
  process.exit(1);
});
