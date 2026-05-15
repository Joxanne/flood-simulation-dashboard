import numpy as np
import pandas as pd
import geopandas as gpd
from shapely.geometry import box, Polygon
from config import CONFIG
import h3
import subprocess  # 新增：用於執行 shell 指令

def generate_h3_geojson(gdf, resolution, output_path):
    """
    將 GeoDataFrame (WGS84) 轉換為 H3 六邊形網格並匯出
    """
    # 1. 計算每個幾何中心的 H3 Index
    # 先轉為投影座標 (TWD97) 計算中心點，再轉回地理座標 (WGS84)
    # 這樣計算出的中心點才是幾何上正確的
    gdf_projected = gdf.to_crs(epsg=3826) 
    centroids_wgs84 = gdf_projected.geometry.centroid.to_crs(epsg=4326)
    
    # h3 v4 API: latlng_to_cell(lat, lng, res)
    gdf['h3'] = centroids_wgs84.apply(lambda p: h3.latlng_to_cell(p.y, p.x, resolution))
    
    # 2. 依照 H3 Index 分組並計算平均深度
    grouped = gdf.groupby('h3')['depth'].mean()
    
    # 3. 將 H3 Index 轉回 Polygon 幾何
    h3_features = []
    for h3_idx, avg_depth in grouped.items():
        boundary_latlon = h3.cell_to_boundary(h3_idx)
        # 轉換為 [(lon, lat), ...] 以符合 GeoJSON/Shapely 格式
        boundary = [(p[1], p[0]) for p in boundary_latlon]
        # 確保閉合
        if boundary[0] != boundary[-1]:
            boundary.append(boundary[0])
            
        poly = Polygon(boundary)
        h3_features.append({'depth': round(avg_depth, 2), 'geometry': poly})
        
    # 4. 建立新的 GeoDataFrame 並匯出
    result_gdf = gpd.GeoDataFrame(h3_features, crs="EPSG:4326")
    result_gdf.to_file(output_path, driver='GeoJSON')
    print(f"成功導出 H3 (Res={resolution}) 至 {output_path}，共 {len(h3_features)} 個六邊形")

def export_flood_twd97_to_geojson(array, lb_x, lb_y, grid_size=40, filename="flood.json"):
    """
    array: flood numpy array
    lb_x, lb_y: TWD97 座標
    return: gdf (WGS84)
    """
    features = []
    rows, cols = array.shape
    
    lt_y = lb_y + (rows - 1) * grid_size
    lt_x = lb_x

    for r in range(rows):
        for c in range(cols):
            val = float(array[r, c])
            if val < 0.3: continue
            
            minx = lt_x + (c * grid_size)
            maxy = lt_y - (r * grid_size)
            maxx = minx + grid_size
            miny = maxy - grid_size
            
            poly = box(minx, miny, maxx, maxy)
            features.append({'depth': val, 'geometry': poly})

    if not features:
        print(f"警告: {filename} 沒有任何淹水網格")
        return None

    # TWD97 -> WGS84
    gdf = gpd.GeoDataFrame(features, crs="EPSG:3826")
    gdf = gdf.to_crs(epsg=4326)
    
    # 匯出原始 L3 (街道級)
    gdf.to_file(filename, driver='GeoJSON')
    print(f"成功導出原始網格 (L3) {filename}，共 {len(features)} 個網格")
    
    return gdf

# 目前關閉此功能（vector_tiles）
def generate_vector_tiles(input_json_path, output_tile_dir):
    """
    呼叫 tippecanoe 將 GeoJSON 轉為 Vector Tiles (L3)
    """
    cmd = [
        "tippecanoe",
        "-e", output_tile_dir,          # 輸出目錄
        "--force",                      # 強制覆蓋
        "-Z", "8",                      # 最小 Zoom
        "-z", "16",                     # 最大 Zoom
        "--no-tile-compression",        # 不壓縮 (方便本地端開發)
        "--drop-densest-as-needed",     # 如果太密則刪減點 (選用)
        input_json_path                 # 來源檔案
    ]
    
    print(f"正在自動生成 Vector Tiles 至 {output_tile_dir} ...")
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        print("⚠️  未找到 'tippecanoe' 指令，跳過 Vector Tiles 生成。")
        print("   請確認已安裝: conda install -c conda-forge tippecanoe")
    except subprocess.CalledProcessError as e:
        print(f"❌ Tippecanoe 執行失敗: {e}")

# 定義風險分級函式 (對應前端的 getColor)
def get_risk_level(depth):
    if depth >= 3: return 5  # 紫紅 (超過紅色上限，視為極端危險)
    if depth >= 1: return 4  # 深紅
    if depth >= 0.5: return 3  # 紅
    if depth >= 0.3: return 2  # 橙
    if depth >= 0.05: return 1 # 深黃
    return 0                   # 忽略



def generate_fake_forecast_data(config=CONFIG):
    """
    生成所有鄉鎮的 3 小時 (T1, T2, T3) 假預測數據
    """
    import random
    forecast_data = {}
    for town in CONFIG['YUNLIN_TOWNS']:
        name = town['name']
        lat, lon = town['coords']

        # 隨機產生 T1, T2, T3 的水位走勢
        # 讓其中幾個鄉鎮比較嚴重 (臺西、口湖)
        if name in ["臺西鄉", "口湖鄉"]:
            base_depth = random.uniform(2.8, 3.3)
        else:
            base_depth = random.uniform(0.0, 1)
            
        trend = []
        current_val = base_depth
        for _ in range(3): # T1, T2, T3
            # 隨機波動
            change = random.uniform(-0.3, 0.3)
            current_val = max(0, current_val + change)
            trend.append(round(current_val, 2))
        
        # 判斷 T3 (第三個時間點) 的風險等級
        final_depth = trend[-1]
        risk_level = "normal"
        if final_depth >= 3: risk_level = "extreme" # 紫紅色
        elif final_depth >= 1: risk_level = "critical"  # 紅色
        elif final_depth >= 0.5: risk_level = "danger" # 橙色
        elif final_depth >= 0.3: risk_level = "warning"  # 黃色
        else: risk_level = "normal" # 綠色 (安全)

        forecast_data[name] = {
            "name": name,
            "lat": lat,
            "lon": lon,
            "forecast": trend, # [T1_depth, T2_depth, T3_depth]
            "riskLevel": risk_level
        }
            
    return forecast_data


if __name__ == "__main__":
    import glob
    import os
    import json

    # 讀取 metadata
    ncols = CONFIG['ncols']
    nrows = CONFIG['nrows']
    xll = CONFIG['xllcorner']
    yll = CONFIG['yllcorner']
    cellsize = CONFIG['cellsize']
    input_dir = CONFIG.get('input_dir', 'flood')
    output_dir = CONFIG.get('output_dir', 'static/output')
    res_L1 = CONFIG.get('res_L1', 7)  # 預設 L1 解析度為 7
    res_L2 = CONFIG.get('res_L2', 8)  # 預設 L2 解析度為 8


    if not os.path.exists(output_dir):
        os.makedirs(output_dir)

    # 取得所有 csv 檔案
    files = sorted(glob.glob(os.path.join(input_dir, "*.csv")))
    
   

    for i, filepath in enumerate(files):
        print(f"Processing {filepath}...")
        try:
            df = pd.read_csv(filepath, header=None)
            array = df.to_numpy()
            # 檢查形狀是否符合 (如果不符合，進行 reshape 或報錯)
            if array.shape != (nrows, ncols):
                 # 有些 CSV 可能是 flatten 的，嘗試 reshape
                 if array.size == nrows * ncols:
                     array = array.reshape((nrows, ncols))
                 else:
                     print(f"Skipping {filepath}: shape {array.shape} mismatch with metadata {(nrows, ncols)}")
                     continue

            filename = os.path.basename(filepath).replace(".csv", ".json")
            output_path = os.path.join(output_dir, filename) # 這會是 L3
            
            # 1. 將檔案轉成geojson (L3)，並取得 WGS84 的 GeoDataFrame (後續用於 L1/L2 生成)
            gdf_wgs84 = export_flood_twd97_to_geojson(array, xll, yll, cellsize, output_path)

            if gdf_wgs84 is not None:
                base_name_no_ext = os.path.splitext(filename)[0]             
                # 2. 產生 L1
                l1_path = os.path.join(output_dir, f"{base_name_no_ext}_L1.json")
                print(f"正在生成 L1 (Res={res_L1})...")
                generate_h3_geojson(gdf_wgs84.copy(), res_L1, l1_path)
                
                # 3. 產生 L2
                l2_path = os.path.join(output_dir, f"{base_name_no_ext}_L2.json")
                print(f"正在生成 L2 (Res={res_L2})...")
                generate_h3_geojson(gdf_wgs84.copy(), res_L2, l2_path)

        except Exception as e:
            print(f"Error processing {filepath}: {e}")

    # 產生 town_forecast.json（假資料）
    forecast_data = generate_fake_forecast_data()
    with open(os.path.join(output_dir, "town_forecast.json"), "w", encoding='utf-8') as f:
        json.dump(forecast_data, f, ensure_ascii=False, indent=2)

    print("Batch processing complete.")