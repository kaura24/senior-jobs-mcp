'use strict';

const aliases = {
  서울: ['서울', '서울특별시'], 부산: ['부산', '부산광역시'], 대구: ['대구', '대구광역시'],
  인천: ['인천', '인천광역시'], 광주: ['광주', '광주광역시'], 대전: ['대전', '대전광역시'],
  울산: ['울산', '울산광역시'], 세종: ['세종', '세종특별자치시'], 경기: ['경기', '경기도'],
  강원: ['강원', '강원도', '강원특별자치도'], 충북: ['충북', '충청북도'], 충남: ['충남', '충청남도'],
  전북: ['전북', '전라북도', '전북특별자치도'], 전남: ['전남', '전라남도'],
  경북: ['경북', '경상북도'], 경남: ['경남', '경상남도'], 제주: ['제주', '제주도', '제주특별자치도'],
};
const provinceAliases = new Map(Object.entries(aliases).flatMap(([canonical, values]) => values.map(value => [value, canonical])));

function normalize(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { raw: raw || null, state: 'missing', province: null, cityDistrict: null };
  const tokens = raw.normalize('NFC').trim().split(/\s+/);
  const province = provinceAliases.get(tokens[0]);
  if (!province) return { raw, state: 'unrecognized', province: null, cityDistrict: null };
  const local = tokens.slice(1);
  const districtRecognized = local.length > 0 && local.every(token => /^[가-힣0-9]+(?:시|군|구)$/.test(token));
  return { raw, state: districtRecognized ? 'recognized' : 'province_only', province,
    cityDistrict: districtRecognized ? local.join(' ') : null,
    normalizationMethod: 'observed_exact_alias_and_explicit_district_tokens', jurisdictionRegistryVerified: false };
}

function counts(values) {
  const frequencies = new Map();
  for (const value of values) frequencies.set(value, (frequencies.get(value) || 0) + 1);
  return [...frequencies].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([value, count]) => ({ value, count }));
}

function distribution(rows) {
  const values = rows.map(row => normalize(row.workPlcNm));
  const missing = values.filter(value => value.state === 'missing');
  const unrecognized = values.filter(value => value.state === 'unrecognized');
  const recognized = values.filter(value => value.province);
  return { sourceField: 'workPlcNm', denominator: rows.length, providedJobs: rows.length - missing.length,
    missingJobs: missing.length, recognizedProvinceJobs: recognized.length, unrecognizedJobs: unrecognized.length,
    districtProvidedJobs: recognized.filter(value => value.cityDistrict).length,
    districtUnrecognizedOrUnspecifiedJobs: recognized.filter(value => !value.cityDistrict).length,
    provinces: counts(recognized.map(value => value.province)),
    cityDistricts: counts(recognized.filter(value => value.cityDistrict).map(value => value.province + ' ' + value.cityDistrict)),
    unrecognizedRawValues: counts(unrecognized.map(value => value.raw)),
    accounting: { totalEqualsProvidedPlusMissing: rows.length === recognized.length + unrecognized.length + missing.length,
      providedEqualsRecognizedPlusUnrecognized: rows.length - missing.length === recognized.length + unrecognized.length },
    optionsOrder: 'name_order_not_popularity_recommendation', optionsComplete: true,
    definitions: { provided: 'nonempty raw region; not a claim that normalization succeeded',
      unrecognized: 'nonempty raw region whose first token has no explicit alias mapping',
      missing: 'empty or absent raw region' } };
}

module.exports = { normalize, distribution };
