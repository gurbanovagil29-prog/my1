'use strict';

/**
 * Ответ Open-Meteo для тестов: days — [{ key, t: [мин, макс], code, pr, pop, snow, gust, uv, rain: [с, до], wind }].
 * Температура по часам: минимум в 5 утра, максимум в 15; «ощущается» на 2° холоднее (при ветре — ещё холоднее).
 */
function openMeteo(days, tz = 'Europe/Moscow') {
  const hourly = { time: [], temperature_2m: [], apparent_temperature: [], precipitation_probability: [], precipitation: [], snowfall: [], weather_code: [], wind_speed_10m: [], wind_gusts_10m: [], uv_index: [], is_day: [] };
  const daily = { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], apparent_temperature_max: [], apparent_temperature_min: [], precipitation_sum: [], precipitation_probability_max: [], snowfall_sum: [], wind_gusts_10m_max: [], uv_index_max: [] };
  for (const d of days) {
    const [lo, hi] = d.t;
    const wind = d.wind || 3;
    const chill = wind >= 8 ? 5 : 2;
    let pr = 0;
    for (let h = 0; h < 24; h++) {
      const k = Math.cos(((h - 15) / 24) * 2 * Math.PI); // 1 в 15:00, −1 в 3:00
      const t = lo + ((hi - lo) * (k + 1)) / 2;
      const raining = d.rain && h >= d.rain[0] && h < d.rain[1];
      hourly.time.push(`${d.key}T${String(h).padStart(2, '0')}:00`);
      hourly.temperature_2m.push(+t.toFixed(1));
      hourly.apparent_temperature.push(+(t - chill).toFixed(1));
      hourly.precipitation_probability.push(raining ? (d.pop ?? 80) : (d.basePop ?? 5));
      hourly.precipitation.push(raining ? (d.snow ? 0 : 1.2) : 0);
      hourly.snowfall.push(raining && d.snow ? 0.8 : 0);
      hourly.weather_code.push(raining ? (d.snow ? 73 : 63) : d.code ?? 2);
      hourly.wind_speed_10m.push(wind);
      hourly.wind_gusts_10m.push(d.gust ?? wind * 1.6);
      hourly.uv_index.push(h >= 11 && h <= 15 ? (d.uv ?? 2) : 0);
      hourly.is_day.push(h >= 7 && h < 19 ? 1 : 0);
      if (raining && !d.snow) pr += 1.2;
    }
    daily.time.push(d.key);
    daily.weather_code.push(d.rain ? (d.snow ? 73 : 63) : d.code ?? 2);
    daily.temperature_2m_max.push(hi);
    daily.temperature_2m_min.push(lo);
    daily.apparent_temperature_max.push(hi - chill);
    daily.apparent_temperature_min.push(lo - chill);
    daily.precipitation_sum.push(+pr.toFixed(1));
    daily.precipitation_probability_max.push(d.rain ? (d.pop ?? 80) : (d.basePop ?? 5));
    daily.snowfall_sum.push(d.rain && d.snow ? 8 : 0);
    daily.wind_gusts_10m_max.push(d.gust ?? wind * 1.6);
    daily.uv_index_max.push(d.uv ?? 2);
  }
  return { timezone: tz, hourly, daily };
}

module.exports = { openMeteo };
