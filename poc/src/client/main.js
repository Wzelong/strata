async function load() {
  try {
    const res = await fetch('/api/stats', { method: 'GET' });
    if (!res.ok) {
      document.getElementById('updated').textContent = 'HTTP ' + res.status;
      return;
    }
    const data = await res.json();
    document.getElementById('embeddings').textContent = data.totalEmbeddings;
    document.getElementById('inspections').textContent = data.totalInspections;
    document.getElementById('auto').textContent = data.autoEmbedded;
    document.getElementById('updated').textContent = 'Updated: ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('updated').textContent = 'Error: ' + e.message;
  }
}

load();
setInterval(load, 10000);
