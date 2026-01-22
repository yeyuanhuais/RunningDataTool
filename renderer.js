const selectFolderButton = document.getElementById('select-folder');
const folderStatus = document.getElementById('folder-status');
const csvSelect = document.getElementById('csv-file');
const metricList = document.getElementById('metric-list');
const pidList = document.getElementById('pid-list');
const chartDom = document.getElementById('chart');
const deployIpInput = document.getElementById('deploy-ip');
const deployUserInput = document.getElementById('deploy-user');
const deployPasswordInput = document.getElementById('deploy-password');
const deployStartButton = document.getElementById('deploy-start');
const downloadCsvButton = document.getElementById('download-csv');
const deployStatus = document.getElementById('deploy-status');
const viewButtons = document.querySelectorAll('[data-view-target]');
const viewPanels = document.querySelectorAll('[data-view]');

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

function updatePidList(restarts) {
  pidList.innerHTML = '';
  restarts.forEach(({ field, restarts: count }) => {
    const item = document.createElement('li');
    item.textContent = `${field}: 重启 ${count} 次`;
    pidList.appendChild(item);
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
  updatePidList(payload.restarts || []);

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

function getDeployPayload() {
  return {
    ip: deployIpInput.value.trim(),
    username: deployUserInput.value.trim() || 'root',
    password: deployPasswordInput.value
  };
}

async function handleDeploy() {
  const payload = getDeployPayload();
  deployStatus.textContent = '正在部署...';
  const result = await window.electronAPI.deployScript(payload);
  deployStatus.textContent = result?.message || '部署完成';
}

async function handleDownloadCsv() {
  const payload = getDeployPayload();
  deployStatus.textContent = '正在下载 CSV...';
  const result = await window.electronAPI.downloadCsv(payload);
  deployStatus.textContent = result?.message || '下载完成';
}

deployStartButton.addEventListener('click', handleDeploy);
downloadCsvButton.addEventListener('click', handleDownloadCsv);

viewButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const target = button.dataset.viewTarget;
    viewButtons.forEach((item) => {
      item.classList.toggle('is-active', item === button);
    });
    viewPanels.forEach((panel) => {
      panel.classList.toggle('is-active', panel.dataset.view === target);
    });
    chart.resize();
  });
});
