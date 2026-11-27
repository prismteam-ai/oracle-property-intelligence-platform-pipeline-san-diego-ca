export const DEFAULT_API_URL = 'https://mywcppj2yl.execute-api.us-east-2.amazonaws.com';

const configured = import.meta.env.VITE_ORACLE_API_URL;

/** Base URL of the serving API. Set VITE_ORACLE_API_URL to point somewhere else. */
export const API_BASE = (
  configured && configured.trim() !== '' ? configured : DEFAULT_API_URL
).replace(/\/+$/, '');
export const MCP_URL = `${API_BASE}/mcp`;
export const AGENT_URL = `${API_BASE}/agent`;

export const COUNTY_NAME = 'San Diego County, CA';
