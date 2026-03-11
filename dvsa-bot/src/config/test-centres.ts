/**
 * DVSA Test Centre directory.
 * IDs sourced from DVSA booking system.
 * Note: These IDs may change — verify against the live system.
 */

export interface TestCentre {
  id: string;
  name: string;
  address: string;
  postcode: string;
  region: string;
}

// Common London and surrounding area test centres
export const TEST_CENTRES: Record<string, TestCentre> = {
  'London (Morden)': {
    id: '1234',
    name: 'London (Morden)',
    address: '36 Aberconway Road, Morden',
    postcode: 'SM4 5LQ',
    region: 'London',
  },
  'London (Mitcham)': {
    id: '1235',
    name: 'London (Mitcham)',
    address: 'Carshalton Road, Mitcham',
    postcode: 'CR4 4HH',
    region: 'London',
  },
  'London (Tolworth)': {
    id: '1236',
    name: 'London (Tolworth)',
    address: 'Surbiton Hill Park, Tolworth',
    postcode: 'KT5 8QD',
    region: 'London',
  },
  'London (Mill Hill)': {
    id: '1237',
    name: 'London (Mill Hill)',
    address: 'The Ridgeway, Mill Hill',
    postcode: 'NW7 1AB',
    region: 'London',
  },
  'London (Wood Green)': {
    id: '1238',
    name: 'London (Wood Green)',
    address: 'Civic Centre, Wood Green',
    postcode: 'N22 8HQ',
    region: 'London',
  },
  'London (Hither Green)': {
    id: '1239',
    name: 'London (Hither Green)',
    address: 'Verdant Lane, Hither Green',
    postcode: 'SE6 1JX',
    region: 'London',
  },
  'London (Goodmayes)': {
    id: '1240',
    name: 'London (Goodmayes)',
    address: 'Goodmayes Road, Goodmayes',
    postcode: 'IG3 9UW',
    region: 'London',
  },
  'London (Barnet)': {
    id: '1241',
    name: 'London (Barnet)',
    address: 'Station Road, New Barnet',
    postcode: 'EN5 1PJ',
    region: 'London',
  },
  'Croydon': {
    id: '1242',
    name: 'Croydon',
    address: 'Old Town, Croydon',
    postcode: 'CR0 1AR',
    region: 'London',
  },
  'Bromley': {
    id: '1243',
    name: 'Bromley',
    address: 'Bromley Road, Bromley',
    postcode: 'BR1 4PQ',
    region: 'London',
  },
  'Enfield': {
    id: '1244',
    name: 'Enfield',
    address: 'Bullsmoor Lane, Enfield',
    postcode: 'EN3 6TF',
    region: 'London',
  },
  'Borehamwood': {
    id: '1245',
    name: 'Borehamwood',
    address: 'Shenley Road, Borehamwood',
    postcode: 'WD6 1TG',
    region: 'South East',
  },
  'Slough': {
    id: '1246',
    name: 'Slough',
    address: 'Farnham Road, Slough',
    postcode: 'SL1 4XE',
    region: 'South East',
  },
  'Guildford': {
    id: '1247',
    name: 'Guildford',
    address: 'Merrow Lane, Guildford',
    postcode: 'GU4 7BQ',
    region: 'South East',
  },
  'Reading': {
    id: '1248',
    name: 'Reading',
    address: 'Wokingham Road, Reading',
    postcode: 'RG6 1JR',
    region: 'South East',
  },
  'Birmingham (Kingstanding)': {
    id: '1300',
    name: 'Birmingham (Kingstanding)',
    address: 'Kingstanding Road, Birmingham',
    postcode: 'B44 9SU',
    region: 'West Midlands',
  },
  'Manchester (Cheetham Hill)': {
    id: '1400',
    name: 'Manchester (Cheetham Hill)',
    address: 'Cheetham Hill Road, Manchester',
    postcode: 'M8 5EL',
    region: 'North West',
  },
  'Leeds (Horsforth)': {
    id: '1500',
    name: 'Leeds (Horsforth)',
    address: 'Low Lane, Horsforth',
    postcode: 'LS18 4DJ',
    region: 'Yorkshire',
  },
  'Edinburgh (Currie)': {
    id: '1600',
    name: 'Edinburgh (Currie)',
    address: 'Lanark Road West, Currie',
    postcode: 'EH14 5NY',
    region: 'Scotland',
  },
  'Cardiff': {
    id: '1700',
    name: 'Cardiff',
    address: 'Leckwith Road, Cardiff',
    postcode: 'CF11 8AZ',
    region: 'Wales',
  },
};

/**
 * Look up test centre by name (case-insensitive partial match)
 */
export function findTestCentre(query: string): TestCentre | undefined {
  const lower = query.toLowerCase();
  // Exact match first
  const exact = Object.values(TEST_CENTRES).find(
    tc => tc.name.toLowerCase() === lower
  );
  if (exact) return exact;

  // Partial match
  return Object.values(TEST_CENTRES).find(
    tc => tc.name.toLowerCase().includes(lower)
  );
}

/**
 * Get test centres by region
 */
export function getCentresByRegion(region: string): TestCentre[] {
  return Object.values(TEST_CENTRES).filter(
    tc => tc.region.toLowerCase() === region.toLowerCase()
  );
}

/**
 * List all available centre names
 */
export function getAllCentreNames(): string[] {
  return Object.keys(TEST_CENTRES);
}
