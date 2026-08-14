/* =========================================================
   CSV Insight Generator
   Vanilla JavaScript — CSV parsing (Papa Parse) + Chart.js
   All processing happens locally in the browser.
   ========================================================= */

(function () {
  'use strict';

  // ---------------------------------------------------------
  // Constants
  // ---------------------------------------------------------
  const MAX_FILE_SIZE = 100 * 1024 * 1024;   // 100 MB hard limit
  const LARGE_FILE_WARNING = 5 * 1024 * 1024; // 5 MB soft warning
  const PREVIEW_ROW_COUNT = 15;
  const TYPE_MATCH_THRESHOLD = 0.8; // 80% of values must match a type to classify a column as that type

  const DATE_REGEXES = [
    /^\d{4}-\d{1,2}-\d{1,2}$/,                 // 2024-01-31
    /^\d{4}\/\d{1,2}\/\d{1,2}$/,                // 2024/01/31
    /^\d{1,2}\/\d{1,2}\/\d{4}$/,                 // 01/31/2024
    /^\d{1,2}-\d{1,2}-\d{4}$/,                   // 31-01-2024
    /^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/,       // Jan 31, 2024 / January 31 2024
    /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/          // 31 Jan 2024
  ];

  // ---------------------------------------------------------
  // App state
  // ---------------------------------------------------------
  const state = {
    fileName: null,
    headers: [],       // final (cleaned) column names
    rows: [],          // array of objects keyed by header
    columnTypes: {},   // header -> 'numeric' | 'text' | 'date'
    charts: []         // Chart.js instances currently on screen
  };

  // ---------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const fileInfo = document.getElementById('fileInfo');
  const fileNameEl = document.getElementById('fileName');
  const fileSizeEl = document.getElementById('fileSize');
  const removeFileBtn = document.getElementById('removeFileBtn');
  const errorAlert = document.getElementById('errorAlert');
  const infoAlert = document.getElementById('infoAlert');
  const resultsWrapper = document.getElementById('resultsWrapper');
  const resetBtn = document.getElementById('resetBtn');

  const kpiGrid = document.getElementById('kpiGrid');
  const previewTable = document.getElementById('previewTable');
  const previewSub = document.getElementById('previewSub');
  const columnGrid = document.getElementById('columnGrid');
  const qualitySection = document.getElementById('qualitySection');
  const chartGrid = document.getElementById('chartGrid');
  const noChartsNote = document.getElementById('noChartsNote');

  // ---------------------------------------------------------
  // Upload interactions
  // ---------------------------------------------------------
  browseBtn.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('click', (e) => {
    // Avoid double-trigger when the Browse button itself was clicked
    if (e.target !== browseBtn) fileInput.click();
  });
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove('drag-over');
    });
  });

  dropzone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files && files[0]) handleFile(files[0]);
  });

  removeFileBtn.addEventListener('click', resetApp);
  resetBtn.addEventListener('click', resetApp);

  // ---------------------------------------------------------
  // File handling & validation
  // ---------------------------------------------------------
  function handleFile(file) {
    clearAlerts();

    const isCsvExtension = file.name.toLowerCase().endsWith('.csv');
    const isCsvType = file.type === 'text/csv' || file.type === 'application/vnd.ms-excel' || file.type === '';
    if (!isCsvExtension || !isCsvType) {
      showError('Please upload a file with a .csv extension.');
      return;
    }

    if (file.size === 0) {
      showError('This file is empty (0 bytes). Please choose a CSV file that contains data.');
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      showError('This file is larger than 100 MB, which is too large to process safely in the browser. Please try a smaller file.');
      return;
    }

    if (file.size > LARGE_FILE_WARNING) {
      showInfo('This is a fairly large file — parsing may take a few seconds.');
    }

    showFileSelected(file);
    parseCsvFile(file);
  }

  function showFileSelected(file) {
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatFileSize(file.size);
    fileInfo.classList.remove('hidden');
    state.fileName = file.name;
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ---------------------------------------------------------
  // CSV Parsing (Papa Parse handles quoted commas, edge cases)
  // ---------------------------------------------------------
  function parseCsvFile(file) {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: 'greedy',
      dynamicTyping: false,
      transformHeader: (h) => h.trim(),
      complete: (results) => {
        try {
          handleParseResults(results);
        } catch (err) {
          console.error(err);
          showError('Something went wrong while analyzing this CSV: ' + err.message);
        }
      },
      error: (err) => {
        console.error(err);
        showError('This file could not be read as a CSV: ' + err.message);
      }
    });
  }

  function handleParseResults(results) {
    const rawFields = results.meta && results.meta.fields ? results.meta.fields : [];
    const rawRows = results.data || [];

    // ---- Validation: empty CSV ----
    if (rawFields.length === 0 && rawRows.length === 0) {
      showError('This CSV file appears to be empty. Please upload a file that contains headers and data.');
      return;
    }

    // ---- Validation: only headers, no data rows ----
    if (rawFields.length > 0 && rawRows.length === 0) {
      showError('This CSV only has column headers but no data rows. Please upload a file that includes at least one row of data.');
      return;
    }

    // ---- Handle empty column names ----
    let emptyHeaderCount = 0;
    const cleanedHeaders = rawFields.map((h, i) => {
      if (!h || h.trim() === '') {
        emptyHeaderCount++;
        return 'Column_' + (i + 1);
      }
      return h;
    });

    // ---- Handle duplicate header names by making them unique ----
    const headerCounts = {};
    const finalHeaders = cleanedHeaders.map((h) => {
      if (headerCounts[h] === undefined) {
        headerCounts[h] = 0;
        return h;
      }
      headerCounts[h] += 1;
      return h + '_' + headerCounts[h];
    });

    // Re-key every row using the final header names (in case headers were renamed)
    const rows = rawRows.map((row) => {
      const newRow = {};
      rawFields.forEach((originalKey, i) => {
        newRow[finalHeaders[i]] = row[originalKey];
      });
      return newRow;
    });

    // ---- Report non-fatal Papa Parse issues (e.g. rows with inconsistent column counts) ----
    if (results.errors && results.errors.length > 0) {
      const seriousErrors = results.errors.filter((e) => e.type !== 'FieldMismatch');
      if (seriousErrors.length > 0 && rows.length === 0) {
        showError('This file does not look like a valid CSV. Please check the formatting and try again.');
        return;
      }
    }

    if (emptyHeaderCount > 0) {
      showInfo(
        emptyHeaderCount === 1
          ? '1 column had no header name, so it was labeled automatically.'
          : emptyHeaderCount + ' columns had no header name, so they were labeled automatically.'
      );
    }

    state.headers = finalHeaders;
    state.rows = rows;

    analyzeAndRender();
  }

  // ---------------------------------------------------------
  // Analysis
  // ---------------------------------------------------------
  function isMissing(value) {
    return value === undefined || value === null || String(value).trim() === '';
  }

  function isNumericValue(value) {
    if (isMissing(value)) return false;
    const cleaned = String(value).trim().replace(/,/g, '');
    if (cleaned === '') return false;
    return !isNaN(cleaned) && isFinite(cleaned);
  }

  function isDateValue(value) {
    if (isMissing(value)) return false;
    const v = String(value).trim();
    const matchesPattern = DATE_REGEXES.some((re) => re.test(v));
    if (!matchesPattern) return false;
    return !isNaN(Date.parse(v));
  }

  function detectColumnType(values) {
    const nonMissing = values.filter((v) => !isMissing(v));
    if (nonMissing.length === 0) return 'text';

    const dateMatches = nonMissing.filter(isDateValue).length;
    if (dateMatches / nonMissing.length >= TYPE_MATCH_THRESHOLD) return 'date';

    const numericMatches = nonMissing.filter(isNumericValue).length;
    if (numericMatches / nonMissing.length >= TYPE_MATCH_THRESHOLD) return 'numeric';

    return 'text';
  }

  function analyzeAndRender() {
    const { headers, rows } = state;

    // Determine column type for each header
    const columnTypes = {};
    headers.forEach((h) => {
      const values = rows.map((r) => r[h]);
      columnTypes[h] = detectColumnType(values);
    });
    state.columnTypes = columnTypes;

    // Missing values (total cells that are empty)
    let missingCount = 0;
    const missingByColumn = {};
    headers.forEach((h) => (missingByColumn[h] = 0));
    rows.forEach((row) => {
      headers.forEach((h) => {
        if (isMissing(row[h])) {
          missingCount++;
          missingByColumn[h]++;
        }
      });
    });

    // Duplicate rows
    const seen = new Set();
    let duplicateCount = 0;
    rows.forEach((row) => {
      const key = JSON.stringify(headers.map((h) => row[h]));
      if (seen.has(key)) duplicateCount++;
      else seen.add(key);
    });

    const numericCols = headers.filter((h) => columnTypes[h] === 'numeric');

    const summary = {
      totalRows: rows.length,
      totalColumns: headers.length,
      numericColumns: numericCols.length,
      missingCount,
      duplicateCount,
      missingByColumn
    };

    renderKpis(summary);
    renderPreviewTable();
    renderColumnInsights(summary);
    renderDataQuality(summary);
    renderCharts();

    resultsWrapper.classList.remove('hidden');
  }

  // ---------------------------------------------------------
  // Rendering: KPI cards
  // ---------------------------------------------------------
  function renderKpis(summary) {
    const cards = [
      { label: 'Total rows', value: summary.totalRows.toLocaleString(), cls: '' },
      { label: 'Total columns', value: summary.totalColumns.toLocaleString(), cls: '' },
      { label: 'Numeric columns', value: summary.numericColumns.toLocaleString(), cls: 'accent' },
      { label: 'Missing values', value: summary.missingCount.toLocaleString(), cls: summary.missingCount > 0 ? 'warn' : '' },
      { label: 'Duplicate rows', value: summary.duplicateCount.toLocaleString(), cls: summary.duplicateCount > 0 ? 'danger' : '' }
    ];

    kpiGrid.innerHTML = cards
      .map(
        (c) => `
        <div class="kpi-card ${c.cls}">
          <div class="kpi-label">${c.label}</div>
          <div class="kpi-value">${c.value}</div>
        </div>`
      )
      .join('');
  }

  // ---------------------------------------------------------
  // Rendering: Data preview table
  // ---------------------------------------------------------
  function renderPreviewTable() {
    const { headers, rows } = state;
    const previewRows = rows.slice(0, PREVIEW_ROW_COUNT);

    previewSub.textContent = `Showing ${previewRows.length} of ${rows.length.toLocaleString()} rows`;

    const theadHtml = '<thead><tr>' + headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('') + '</tr></thead>';

    const tbodyHtml =
      '<tbody>' +
      previewRows
        .map((row) => {
          const cells = headers
            .map((h) => {
              const val = row[h];
              if (isMissing(val)) return '<td class="empty-cell">—</td>';
              return `<td>${escapeHtml(String(val))}</td>`;
            })
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('') +
      '</tbody>';

    previewTable.innerHTML = theadHtml + tbodyHtml;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------------------------------------------------
  // Rendering: Column insights
  // ---------------------------------------------------------
  function renderColumnInsights(summary) {
    const { headers, rows, columnTypes } = state;

    columnGrid.innerHTML = headers
      .map((h) => {
        const type = columnTypes[h];
        const values = rows.map((r) => r[h]);
        const missing = summary.missingByColumn[h];
        let statsHtml = '';

        if (type === 'numeric') {
          const nums = values.filter(isNumericValue).map((v) => parseFloat(String(v).replace(/,/g, '')));
          const stats = numericStats(nums);
          statsHtml = `
            <li><span>Minimum</span><span>${formatNumber(stats.min)}</span></li>
            <li><span>Maximum</span><span>${formatNumber(stats.max)}</span></li>
            <li><span>Average</span><span>${formatNumber(stats.avg)}</span></li>
            <li><span>Median</span><span>${formatNumber(stats.median)}</span></li>
            <li><span>Missing</span><span>${missing}</span></li>`;
        } else if (type === 'date') {
          const dates = values.filter(isDateValue).map((v) => new Date(v));
          const minDate = new Date(Math.min.apply(null, dates));
          const maxDate = new Date(Math.max.apply(null, dates));
          statsHtml = `
            <li><span>Earliest date</span><span>${dates.length ? minDate.toLocaleDateString() : '—'}</span></li>
            <li><span>Latest date</span><span>${dates.length ? maxDate.toLocaleDateString() : '—'}</span></li>
            <li><span>Missing</span><span>${missing}</span></li>`;
        } else {
          const nonMissingValues = values.filter((v) => !isMissing(v)).map((v) => String(v).trim());
          const freq = frequencyMap(nonMissingValues);
          const uniqueCount = Object.keys(freq).length;
          const top = topEntry(freq);
          statsHtml = `
            <li><span>Unique values</span><span>${uniqueCount}</span></li>
            <li><span>Most frequent</span><span title="${escapeHtml(top ? top[0] : '—')}">${escapeHtml(top ? truncate(top[0], 18) : '—')}</span></li>
            <li><span>Missing</span><span>${missing}</span></li>`;
        }

        return `
          <div class="column-card">
            <div class="column-card-head">
              <span class="column-name" title="${escapeHtml(h)}">${escapeHtml(h)}</span>
              <span class="type-badge ${type}">${type}</span>
            </div>
            <ul class="column-stats">${statsHtml}</ul>
          </div>`;
      })
      .join('');
  }

  function numericStats(nums) {
    if (nums.length === 0) return { min: NaN, max: NaN, avg: NaN, median: NaN };
    const sorted = [...nums].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    return { min, max, avg, median };
  }

  function formatNumber(n) {
    if (isNaN(n)) return '—';
    if (Number.isInteger(n)) return n.toLocaleString();
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  function frequencyMap(arr) {
    const map = {};
    arr.forEach((v) => (map[v] = (map[v] || 0) + 1));
    return map;
  }

  function topEntry(freqMap) {
    const entries = Object.entries(freqMap);
    if (entries.length === 0) return null;
    return entries.reduce((best, curr) => (curr[1] > best[1] ? curr : best));
  }

  function truncate(str, len) {
    return str.length > len ? str.slice(0, len) + '…' : str;
  }

  // ---------------------------------------------------------
  // Rendering: Data quality
  // ---------------------------------------------------------
  function renderDataQuality(summary) {
    const { headers, rows } = state;
    const totalCells = rows.length * headers.length;

    // Simple, explainable quality formula:
    // Quality % = 100 x (1 - (missing cells + duplicate rows) / (total rows x total columns))
    const penalizedUnits = summary.missingCount + summary.duplicateCount;
    let qualityPct = totalCells > 0 ? 100 * (1 - penalizedUnits / totalCells) : 100;
    qualityPct = Math.max(0, Math.min(100, qualityPct));
    const qualityRounded = Math.round(qualityPct);

    const affectedColumns = headers.filter((h) => summary.missingByColumn[h] > 0);

    const ringColor =
      qualityRounded >= 90 ? 'var(--color-accent)' : qualityRounded >= 70 ? 'var(--color-warn)' : 'var(--color-danger)';

    const circumference = 2 * Math.PI * 60;
    const dashOffset = circumference * (1 - qualityPct / 100);

    qualitySection.innerHTML = `
      <div class="quality-score-wrap">
        <div class="quality-ring" title="Data quality score">
          <svg width="150" height="150" viewBox="0 0 150 150">
            <circle cx="75" cy="75" r="60" fill="none" stroke="var(--color-border)" stroke-width="12" />
            <circle cx="75" cy="75" r="60" fill="none" stroke="${ringColor}" stroke-width="12"
              stroke-dasharray="${circumference}" stroke-dashoffset="${dashOffset}" stroke-linecap="round" />
          </svg>
          <div class="quality-ring-value">${qualityRounded}%</div>
        </div>
        <p class="quality-formula" title="Quality % = 100 × (1 − (missing cells + duplicate rows) ÷ (total rows × total columns))">
          Quality % = 100 × (1 − (missing + duplicates) ÷ total cells). Hover for the full formula.
        </p>
      </div>
      <div class="quality-details">
        <div class="quality-stat">
          <div class="quality-stat-label">Missing values</div>
          <div class="quality-stat-value">${summary.missingCount.toLocaleString()}</div>
        </div>
        <div class="quality-stat">
          <div class="quality-stat-label">Duplicate rows</div>
          <div class="quality-stat-value">${summary.duplicateCount.toLocaleString()}</div>
        </div>
        <div class="quality-stat">
          <div class="quality-stat-label">Total cells checked</div>
          <div class="quality-stat-value">${totalCells.toLocaleString()}</div>
        </div>
        <div class="quality-stat">
          <div class="quality-stat-label">Columns with missing data</div>
          <div class="quality-stat-value">${affectedColumns.length}</div>
        </div>
        <div class="quality-cols-list">
          ${
            affectedColumns.length > 0
              ? `<b>Affected columns:</b> ${affectedColumns.map(escapeHtml).join(', ')}`
              : '<b>No columns have missing data.</b> Nice and clean!'
          }
        </div>
      </div>
    `;
  }

  // ---------------------------------------------------------
  // Rendering: Charts
  // ---------------------------------------------------------
  function destroyCharts() {
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
  }

  function addChartCard(title) {
    const wrapper = document.createElement('div');
    wrapper.className = 'chart-card';
    wrapper.innerHTML = `<h3>${escapeHtml(title)}</h3><div class="chart-canvas-wrap"><canvas></canvas></div>`;
    chartGrid.appendChild(wrapper);
    return wrapper.querySelector('canvas');
  }

  const CHART_COLORS = ['#3454D1', '#0E9F8E', '#B65E14', '#7C3AED', '#C0392B', '#0891B2'];

  function renderCharts() {
    chartGrid.innerHTML = '';
    destroyCharts();

    const { headers, rows, columnTypes } = state;
    const numericCols = headers.filter((h) => columnTypes[h] === 'numeric');
    const dateCols = headers.filter((h) => columnTypes[h] === 'date');

    const categoricalCols = headers.filter((h) => {
      if (columnTypes[h] !== 'text') return false;
      const values = rows.map((r) => r[h]).filter((v) => !isMissing(v)).map((v) => String(v).trim());
      if (values.length === 0) return false;
      const uniqueCount = new Set(values).size;
      // Skip identifier-like columns where every value is unique — a bar chart there is not meaningful
      return uniqueCount < values.length;
    });

    let chartsCreated = 0;

    // Histograms for up to 4 numeric columns
    numericCols.slice(0, 4).forEach((col, idx) => {
      const nums = rows.map((r) => r[col]).filter(isNumericValue).map((v) => parseFloat(String(v).replace(/,/g, '')));
      if (nums.length < 2) return;
      createHistogram(col, nums, CHART_COLORS[idx % CHART_COLORS.length]);
      chartsCreated++;
    });

    // Scatter chart for the first two numeric columns
    if (numericCols.length >= 2) {
      const [colX, colY] = numericCols;
      const points = rows
        .map((r) => ({ x: r[colX], y: r[colY] }))
        .filter((p) => isNumericValue(p.x) && isNumericValue(p.y))
        .map((p) => ({ x: parseFloat(String(p.x).replace(/,/g, '')), y: parseFloat(String(p.y).replace(/,/g, '')) }));
      if (points.length >= 2) {
        createScatter(colX, colY, points);
        chartsCreated++;
      }
    }

    // Bar charts of top values for up to 3 categorical columns
    categoricalCols.slice(0, 3).forEach((col, idx) => {
      const values = rows.map((r) => r[col]).filter((v) => !isMissing(v)).map((v) => String(v).trim());
      const freq = frequencyMap(values);
      const topEntries = Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);
      if (topEntries.length === 0) return;
      createCategoryBar(col, topEntries, CHART_COLORS[(idx + 2) % CHART_COLORS.length]);
      chartsCreated++;
    });

    // Line chart for the first date column + first numeric column
    if (dateCols.length >= 1 && numericCols.length >= 1) {
      const dateCol = dateCols[0];
      const numCol = numericCols[0];
      let points = rows
        .map((r) => ({ date: r[dateCol], value: r[numCol] }))
        .filter((p) => isDateValue(p.date) && isNumericValue(p.value))
        .map((p) => ({ date: new Date(p.date), value: parseFloat(String(p.value).replace(/,/g, '')) }))
        .sort((a, b) => a.date - b.date);

      // Downsample if there are too many points, to keep the chart readable
      if (points.length > 300) {
        const step = Math.ceil(points.length / 300);
        points = points.filter((_, i) => i % step === 0);
      }

      if (points.length >= 2) {
        createDateLine(dateCol, numCol, points);
        chartsCreated++;
      }
    }

    noChartsNote.classList.toggle('hidden', chartsCreated > 0);
  }

  function buildHistogramBins(nums, binCount) {
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (min === max) {
      return { labels: [formatNumber(min)], counts: [nums.length] };
    }
    const binSize = (max - min) / binCount;
    const counts = new Array(binCount).fill(0);
    nums.forEach((n) => {
      let idx = Math.floor((n - min) / binSize);
      if (idx >= binCount) idx = binCount - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    });
    const labels = counts.map((_, i) => {
      const start = min + i * binSize;
      const end = start + binSize;
      return `${formatNumber(start)}–${formatNumber(end)}`;
    });
    return { labels, counts };
  }

  function createHistogram(colName, nums, color) {
    const canvas = addChartCard(`Distribution of "${colName}"`);
    const { labels, counts } = buildHistogramBins(nums, Math.min(10, Math.max(4, Math.ceil(Math.sqrt(nums.length)))));
    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{ label: 'Count', data: counts, backgroundColor: color, borderRadius: 4 }]
      },
      options: baseChartOptions('Value range', 'Count')
    });
    state.charts.push(chart);
  }

  function createScatter(colX, colY, points) {
    const canvas = addChartCard(`"${colX}" vs "${colY}"`);
    const chart = new Chart(canvas, {
      type: 'scatter',
      data: {
        datasets: [{ label: `${colX} vs ${colY}`, data: points, backgroundColor: '#3454D1' }]
      },
      options: baseChartOptions(colX, colY)
    });
    state.charts.push(chart);
  }

  function createCategoryBar(colName, topEntries, color) {
    const canvas = addChartCard(`Top values in "${colName}"`);
    const chart = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: topEntries.map((e) => truncate(e[0], 16)),
        datasets: [{ label: 'Count', data: topEntries.map((e) => e[1]), backgroundColor: color, borderRadius: 4 }]
      },
      options: { ...baseChartOptions('Value', 'Count'), indexAxis: topEntries.length > 5 ? 'y' : 'x' }
    });
    state.charts.push(chart);
  }

  function createDateLine(dateCol, numCol, points) {
    const canvas = addChartCard(`"${numCol}" over "${dateCol}"`);
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: points.map((p) => p.date.toLocaleDateString()),
        datasets: [
          {
            label: numCol,
            data: points.map((p) => p.value),
            borderColor: '#0E9F8E',
            backgroundColor: 'rgba(14, 159, 142, 0.12)',
            fill: true,
            tension: 0.25,
            pointRadius: points.length > 60 ? 0 : 3
          }
        ]
      },
      options: baseChartOptions(dateCol, numCol)
    });
    state.charts.push(chart);
  }

  function baseChartOptions(xLabel, yLabel) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { title: { display: true, text: xLabel }, grid: { display: false } },
        y: { title: { display: true, text: yLabel }, grid: { color: '#EEF1F6' } }
      }
    };
  }

  // ---------------------------------------------------------
  // Alerts
  // ---------------------------------------------------------
  function showError(message) {
    errorAlert.textContent = message;
    errorAlert.classList.remove('hidden');
    infoAlert.classList.add('hidden');
  }

  function showInfo(message) {
    infoAlert.textContent = message;
    infoAlert.classList.remove('hidden');
  }

  function clearAlerts() {
    errorAlert.classList.add('hidden');
    infoAlert.classList.add('hidden');
    errorAlert.textContent = '';
    infoAlert.textContent = '';
  }

  // ---------------------------------------------------------
  // Reset
  // ---------------------------------------------------------
  function resetApp() {
    state.fileName = null;
    state.headers = [];
    state.rows = [];
    state.columnTypes = {};
    destroyCharts();

    fileInput.value = '';
    fileInfo.classList.add('hidden');
    resultsWrapper.classList.add('hidden');
    clearAlerts();

    kpiGrid.innerHTML = '';
    previewTable.innerHTML = '';
    columnGrid.innerHTML = '';
    qualitySection.innerHTML = '';
    chartGrid.innerHTML = '';
    noChartsNote.classList.add('hidden');
  }
})();
