// layoutMapping.js: the source carries counts only (BEDROOMS, BATHS, GARAGE_STALLS,
// CARPORT_STALLS, POOL). The lexicon has no count fields: a bedroom is one `layout` record,
// and every layout record requires non-null booleans `is_finished` and `is_exterior` that the
// assessor record does not state. Writing them would mean asserting values the source does
// not hold, so this script writes no layout and passes the counts on as a recorded gap.
'use strict';

const path = require('path');
const { paddedInt, readFeature, text, writeJson } = require('./sd_common.js');

const feature = readFeature(process.cwd());
const a = feature === null ? {} : feature.attributes;
const baths = paddedInt(a.baths);

writeJson(path.join(process.cwd(), 'owners', 'layout_data.json'), {
  layouts: [],
  reason:
    'lexicon layout needs one record per room with non-null is_finished / is_exterior; the source has counts only',
  not_mapped: {
    bedrooms: paddedInt(a.bedrooms),
    baths: baths === null ? null : baths / 10,
    garage_stalls: paddedInt(a.garage_stalls),
    carport_stalls: paddedInt(a.carport_stalls),
    pool: text(a.pool),
    garage_conversion: text(a.garage_conversion),
  },
});
