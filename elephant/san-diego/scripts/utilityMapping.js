// utilityMapping.js: the SANDAG / SanGIS Parcels layer has no utility attributes (no
// heating, cooling, water, sewer, electrical or solar fields), so no lexicon `utility`
// record is written. The file below only tells data_extractor.js that this was checked.
'use strict';

const path = require('path');
const { writeJson } = require('./sd_common.js');

writeJson(path.join(process.cwd(), 'owners', 'utilities_data.json'), {
  utility: null,
  reason: 'source layer has no utility fields',
});
