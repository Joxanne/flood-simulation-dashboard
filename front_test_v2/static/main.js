// ==========================================================
// 初始化 DeckGL + MapLibre
// ==========================================================

// 定義顏色映射 (R, G, B, A)
// 紅: [211, 47, 47], 橙: [245, 124, 0], 黃: [251, 192, 45], 綠色: [76, 175, 80]
function getColor(depth) {
    if (depth >= 3) return [128, 0, 128, 200]; // Purple (Extreme)
    if (depth >= 1) return [211, 47, 47, 200];   // Dark Red (Danger)
    if (depth >= 0.5) return [245, 124, 0, 200]; // orange
    if (depth >= 0.3) return [251, 192, 45, 200]; // yellow
    return [76, 175, 80, 0]; // Transparent
}

// 模擬 Leaflet 的全域變數
let townForecastData = {};
let currentZoom = 11;

// 初始化 DeckGL
const deckgl = new deck.DeckGL({
    container: 'map',
    map: maplibregl, // 使用 MapLibre 作為底圖
    initialViewState: {
        longitude: 120.4,
        latitude: 23.7,
        zoom: 11,
        pitch: 0,
        bearing: 0
    },
    controller: true,
    mapStyle: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json', // Carto Positron Vector Style
    onViewStateChange: ({viewState}) => {
        currentZoom = viewState.zoom;
        renderLayers();
    },
    getTooltip: ({object}) => {
        if (!object) return null;
        
        // 1. Point Layer (Warnings)
        if (object.riskLevel) {
            let riskText = "";
            if (object.riskLevel === 'extreme') riskText = " (極度危險)";
            else if (object.riskLevel === 'critical') riskText = " (中度危險)";
            else if (object.riskLevel === 'danger') riskText = " (輕度危險)";
            else if (object.riskLevel === 'warning') riskText = " (警告)";
            else riskText = " (安全)";

            return {
                html: `<b>${object.name}</b>${riskText}<br>預測深度: ${object.forecast[2]}m`,
                style: {
                    backgroundColor: '#fff',
                    color: '#000',
                    fontSize: '0.9em',
                    padding: '8px',
                    borderRadius: '4px',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
                }
            };
        }
        
        // 2. MVT / GeoJSON (Flood)
        if (object.properties && object.properties.depth) {
            return {
                html: `<b>深度:</b> ${object.properties.depth} m`,
                style: {
                    backgroundColor: 'rgba(0,0,0,0.8)',
                    color: '#fff',
                    fontSize: '0.8em'
                }
            };
        }
        return null;
    }
});

// ==========================================================
// 資料載入與圖層管理
// ==========================================================

function renderLayers() {
    const layers = [];
    
    // ----------------------------------------------------------------
    // 1. Flood Layers (Base Layers)
    // ----------------------------------------------------------------
    // Logic: Zoom < 10 -> L1 (Res 6)
    //        Zoom < 11 -> L2 (Res 7)
    //        Zoom >= 11 -> L3 (Vector Tiles)
    
    //之後要接model的output，現在先寫死
    const timeStep = 3; // 固定 T3
    const baseName = `t5_SW_00${96 + timeStep}`; // e.g. t5_SW_0099
    
    if (currentZoom >= 11) {
        // L3: Vector Tile Layer (MVT)
        const geoJsonUrl = `static/output/${baseName}.json`;
        layers.push(
            new deck.GeoJsonLayer({
                id: `flood-geojson`,
                data: geoJsonUrl,
                filled: true,
                stroked: false,
                getFillColor: f => getColor(f.properties.depth),
                getLineColor: f => getColor(f.properties.depth), // 邊框同色以平滑
                lineWidthMinPixels: 0,
                opacity: 0.7,
                pickable: true,
                autoHighlight: true
            })
        );
    } else {
        // L1 / L2: GeoJSON Layer
        const suffix = (currentZoom < 10) ? "_L1" : "_L2";
        const geoJsonUrl = `static/output/${baseName}${suffix}.json`;
       
        layers.push(
            new deck.GeoJsonLayer({
                id: `flood-geojson-${suffix}`,
                data: geoJsonUrl,
                filled: true,
                stroked: true,
                getFillColor: f => getColor(f.properties.depth),
                getLineColor: f => getColor(f.properties.depth), // 邊框同色以平滑
                getLineWidth: 2,
                lineWidthMinPixels: 2,
                strokeOpacity: 0.7,
                opacity: 0.1,
                pickable: true,
                autoHighlight: true
            })
        );
    }

    // ----------------------------------------------------------------
    // 2. Alert Points Layer (Scatterplot)
    // ----------------------------------------------------------------
    const alertData = Object.values(townForecastData); // Convert dict values to array
    
    if (alertData.length > 0) {
        // 定義顏色映射 (T3 Risk Level)
        const getRiskColor = (level) => {
            switch(level) {
                case 'extreme': return [255, 0, 255]; // Purple
                case 'critical': return [244, 67, 54]; // Dark Red
                case 'danger': return [255, 152, 0];  // Orange
                case 'warning': return [255, 235, 59]; // Yellow
                default: return [76, 175, 80];        // Green
            }
        };

        // 畫圓點
        layers.push(
            new deck.ScatterplotLayer({
                id: 'town-alerts',
                data: alertData,
                getPosition: d => [d.lon, d.lat],
                getFillColor: d => getRiskColor(d.riskLevel),
                getLineColor: [255, 255, 255],
                getLineWidth: 4,
                lineWidthMinPixels: 4,
                stroked: true,
                getRadius: 800,
                radiusMinPixels: 8,
                radiusMaxPixels: 8,
                opacity: 1,
                pickable: true,
                onClick: (info) => {
                    if (info.object) {
                        renderChart(info.object.name, info.object.forecast);
                    }
                },
                updateTriggers: {
                    getFillColor: alertData 
                }
            })
        );
        
        // 額外的 "閃爍" 效果 (動態 Radius 與 Opacity)
        const extremeData = alertData.filter(d => d.riskLevel === 'extreme');
        if (extremeData.length > 0) {
             // 計算動態值 (0.0 ~ 1.0)
             const t = (Date.now() % 2000) / 2000;
             const rScale = 1 + t; // 1.0 -> 2.0 (半徑放大兩倍)
             const alpha = 200 * (1 - t); // 200 -> 0 (透明度漸減)

             layers.push(
                new deck.ScatterplotLayer({
                    id: 'town-alerts-halo',
                    data: extremeData,
                    getPosition: d => [d.lon, d.lat],
                    getFillColor: [128, 0, 128, alpha], // 紫紅色漸淡
                    getRadius: 800 * rScale, // 半徑放大 (基準 800m)
                    radiusMinPixels: 6 * rScale,
                    radiusMaxPixels: 20 * rScale,
                    stroked: false,
                    pickable: false,
                    // 重要：告訴 DeckGL 需要持續更新
                    updateTriggers: {
                        getRadius: t,
                        getFillColor: t
                    }
                })
             );
             
             // 繼續下一幀
             requestAnimationFrame(renderLayers);
        }
    }

    deckgl.setProps({ layers });
}

// ==========================================================
// 後端資料互動 Logic (Chart & Load Data)
// ==========================================================

// 載入 Town Forecast 資料
async function loadTownAlerts() {
    try {
        const response = await fetch('static/output/town_forecast.json');
        townForecastData = await response.json();
        renderLayers();
    } catch (e) {
        console.error("無法載入 town_forecast.json", e);
    }
}

// 建立或更新圖表
let myChart = null;

function renderChart(townName, trendData) {
    const ctx = document.getElementById('floodChart').getContext('2d');
    
    // 隱藏 placeholder，顯示 chart
    document.getElementById('placeholder-text').style.display = 'none';
    document.getElementById('chart-container').style.display = 'block';
    document.getElementById('sidebar-title').innerText = `📍 ${townName} 預測資訊`;

    // 如果已經有圖表，先銷毀
    if (myChart) {
        myChart.destroy();
    }

    const labels = ['+1h', '+2h', '+3h'];
    
    // 設定警戒線的值
   
    const warningVal = 0.3;
    const dangerVal = 0.5;
    const criticalVal = 1.0;
    const extremeVal = 3.0;

    myChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: '預測淹水深度 (m)',
                data: trendData,
                borderColor: '#1976D2', // Blue
                backgroundColor: 'rgba(25, 118, 210, 0.2)',
                borderWidth: 3,
                tension: 0.3, // 平滑曲線
                pointRadius: 5,
                fill: true
            },
            // Dummy datasets for Legend
            {
                label: '警告 (0.3m)',
                data: [],
                backgroundColor: '#FBC02D',
                borderColor: '#FBC02D',
                pointRadius: 0.5,
            },
            {
                label: '輕危 (0.5m)',
                data: [],
                backgroundColor: '#F57C00',
                borderColor: '#F57C00',
                pointRadius: 0.5,

            },
            {
                label: '中危 (1.0m)',
                data: [],
                backgroundColor: '#D32F2F',
                borderColor: '#D32F2F',
                pointRadius: 0.5,

            },
            {
                label: '極危 (3.0m)',
                data: [],
                backgroundColor: '#800080',
                borderColor: '#800080',
                pointRadius: 0.5,
          
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: '深度 (m)' },
                    suggestedMax: 3.5
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        
                        boxWidth: 10,
                        padding: 10,
                        font: {
                            size: 12
                        }
                    }
                },
                annotation: {
                    annotations: {
                        line1: {
                            type: 'line',
                            yMin: warningVal,
                            yMax: warningVal,
                            borderColor: '#FBC02D', // Yellow
                            borderWidth: 2,
                            borderDash: [],
                            label: { display: false }
                        },
                        line2: {
                            type: 'line',
                            yMin: dangerVal,
                            yMax: dangerVal,
                            borderColor: '#F57C00', // Orange
                            borderWidth: 2,
                            borderDash: [],
                            label: { display: false }
                        },
                        line3: {
                            type: 'line',
                            yMin: criticalVal,
                            yMax: criticalVal,
                            borderColor: '#D32F2F', // Red
                            borderWidth: 2,
                            borderDash: [],
                            label: { display: false }
                        },
                        line4: {
                            type: 'line',
                            yMin: extremeVal,
                            yMax: extremeVal,
                            borderColor: '#800080', // Purple
                            borderWidth: 2,
                            borderDash: [],
                            label: { display: false }
                        }
                    }
                }

            }
        }
    });

    myChart.update();
    
    // 確保 Sidebar 展開
    const sidebar = document.getElementById('sidebar');
    const btn = document.getElementById('toggle-sidebar');
    if (sidebar.classList.contains('collapsed')) {
        sidebar.classList.remove('collapsed');
        btn.innerText = '▲';
    }
}

document.getElementById('toggle-sidebar').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const btn = document.getElementById('toggle-sidebar');
    
    // Toggle class
    sidebar.classList.toggle('collapsed');
    
    // Update Icon
    if (sidebar.classList.contains('collapsed')) {
        btn.innerText = '▼'; // 顯示向下展開
    } else {
        btn.innerText = '▲'; // 顯示向上收合
    }
});

// 初始執行
loadTownAlerts();
loadFloodLayer(3); // 固定載入 T3 (三小時後)
