const selectFolderButton = document.getElementById('select-folder');
const folderStatus = document.getElementById('folder-status');
const csvSelect = document.getElementById('csv-file');
const metricList = document.getElementById('metric-list');
const chartDom = document.getElementById('chart');

const chart = echarts.init(chartDom);
let currentFolder = null;

function updateMetricList(metrics) {
  metricList.innerHTML = '';
  metrics.forEach((metric) => {
    const item = document.createElement('li');
    item.textContent = metric;
    metricList.appendChild(item);
  });
}

function updateChart(payload) {
  if (!payload) {
    chart.clear();
    updateMetricList([]);
    return;
  }

  const { timeAxis, series, metrics } = payload;
  updateMetricList(metrics);

  chart.setOption({
    tooltip: {
      trigger: 'axis'
    },
    legend: {
      type: 'scroll'
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '10%',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      data: timeAxis
    },
    yAxis: {
      type: 'value'
    },
    dataZoom: [
      {
        type: 'slider'
      },
      {
        type: 'inside'
      }
    ],
    series
  });
}

function setSelectOptions(files) {
  csvSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.textContent = '请选择';
  placeholder.value = '';
  csvSelect.appendChild(placeholder);

  files.forEach((file) => {
    const option = document.createElement('option');
    option.value = file;
    option.textContent = file;
    csvSelect.appendChild(option);
  });

  csvSelect.disabled = files.length === 0;
}

async function handleFolderSelection() {
  const result = await window.electronAPI.selectFolder();
  if (!result || !result.folder) {
    folderStatus.textContent = '未选择文件夹';
    setSelectOptions([]);
    updateChart(null);
    return;
  }

  currentFolder = result.folder;
  folderStatus.textContent = `当前文件夹: ${result.folder}`;
  setSelectOptions(result.files);
  updateChart(null);
}

async function handleCsvSelection() {
  const filename = csvSelect.value;
  if (!filename || !currentFolder) {
    updateChart(null);
    return;
  }
  const payload = await window.electronAPI.loadCsv(currentFolder, filename);
  updateChart(payload);
}

selectFolderButton.addEventListener('click', handleFolderSelection);
csvSelect.addEventListener('change', handleCsvSelection);

window.addEventListener('resize', () => {
  chart.resize();
});
