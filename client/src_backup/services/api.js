import axios from 'axios';

const API_BASE = '/api';

export const api = {
  getBanks: async () => {
    const res = await axios.get(`${API_BASE}/banks`);
    return res.data;
  },
  getRates: async (params = {}) => {
    const res = await axios.get(`${API_BASE}/rates`, { params });
    return res.data;
  },
  getHighestRates: async () => {
    const res = await axios.get(`${API_BASE}/rates/highest`);
    return res.data;
  },
  getAuditReport: async () => {
    const res = await axios.get(`${API_BASE}/audit/report`);
    return res.data;
  },
  triggerScrape: async (payload = {}) => {
    const res = await axios.post(`${API_BASE}/scrape/trigger`, payload);
    return res.data;
  }
};

export default api;
