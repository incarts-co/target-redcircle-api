/**
 * @fileoverview Target RedCircle API client
 * @description Handles all API calls to Target RedCircle API with concurrent request support
 * @module services/target/api
 * @related services/stock/availability.ts, types/index.ts
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import {
  TargetStoreStockResponse,
  TargetProductResponse,
  TargetProductFullResponse,
  TargetSearchResponse,
  ApiError,
  ApiRequestOptions,
} from '../../types';
import {
  productCache,
  stockCache,
  getCachedValue,
  setCachedValue,
  generateProductCacheKey,
  generateProductStockCacheKey,
} from '../../utils/cache';

// ============================================================================
// API Configuration
// ============================================================================

const API_KEY = process.env.TARGET_API_KEY || '';
const BASE_URL = process.env.TARGET_API_BASE_URL || 'https://api.redcircleapi.com/request';
const DEFAULT_TIMEOUT = 10000; // 10 seconds

if (!API_KEY && process.env.NODE_ENV !== 'test') {
  console.warn(
    '[Target API] WARNING: TARGET_API_KEY not set in environment variables',
  );
}

/**
 * Axios instance for Target RedCircle API
 */
const axiosInstance: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: DEFAULT_TIMEOUT,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Transform axios error to ApiError
 *
 * @param error - Axios error
 * @param context - Error context (e.g., TCIN, operation)
 * @returns ApiError instance
 */
function handleApiError(error: unknown, context?: string): ApiError {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    const data = axiosError.response?.data as unknown;

    // Type guard helper for error response
    const isErrorResponse = (d: unknown): d is { error?: { code?: string } } => typeof d === 'object' && d !== null;

    const errorCode = isErrorResponse(data) ? data.error?.code : undefined;

    // RedCircle API error codes
    if (status === 404 || errorCode === 'PRODUCT_NOT_FOUND') {
      return new ApiError(
        `Product not found${context ? `: ${context}` : ''}`,
        'PRODUCT_NOT_FOUND',
        { context, status },
      );
    }

    if (status === 429 || errorCode === 'RATE_LIMIT_EXCEEDED') {
      return new ApiError('Rate limit exceeded', 'RATE_LIMIT_EXCEEDED', {
        context,
        retryAfter: axiosError.response?.headers['retry-after'],
      });
    }

    if (status === 401 || status === 403) {
      return new ApiError('Invalid API key or unauthorized', 'UNAUTHORIZED', {
        context,
        status,
      });
    }

    return new ApiError(axiosError.message, status || 'NETWORK_ERROR', {
      context,
      originalError: axiosError.message,
    });
  }

  return new ApiError('Unknown error occurred', 'UNKNOWN_ERROR', {
    context,
    originalError: String(error),
  });
}

// ============================================================================
// Store Stock API
// ============================================================================

/**
 * Check store stock for a single TCIN
 * Uses type=store_stock endpoint
 *
 * @param tcin - Target TCIN (8-digit product ID)
 * @param zipCode - ZIP code for location-based availability
 * @param storeId - DEPRECATED: Not used by API. Store filtering done client-side
 * @param options - Request options
 * @returns Store stock response with up to 20 stores within 50 mile radius
 * @throws ApiError if request fails
 *
 * @example
 * const stock = await checkStoreStock('78025470', '04457');
 * const closestStore = stock.store_stock_results?.[0];
 * console.log(closestStore?.in_stock); // true/false
 *
 * @note The storeId parameter is kept for backwards compatibility but is not
 *       sent to the RedCircle API as it's not supported. Store filtering must
 *       be done client-side on the returned results.
 */
export async function checkStoreStock(
  tcin: string,
  zipCode: string,
  _storeId?: string,
  options?: ApiRequestOptions,
): Promise<TargetStoreStockResponse> {
  // Check cache first (unless explicitly skipped)
  // Note: We don't include storeId in cache key since API doesn't filter by store
  // All requests for same tcin+zipcode return the same store list
  if (!options?.skipCache) {
    const cacheKey = generateProductStockCacheKey(zipCode, tcin);
    const cached = getCachedValue<TargetStoreStockResponse>(
      stockCache,
      cacheKey,
    );
    if (cached) {
      return cached;
    }
  }

  try {
    // _storeId parameter is kept for backwards compatibility but not used
    // RedCircle API doesn't support store filtering - returns all stores within 50 miles

    const params: Record<string, string> = {
      api_key: API_KEY,
      type: 'store_stock',
      tcin,
      store_stock_zipcode: zipCode,
    };

    // Note: store_id is NOT supported by RedCircle store_stock API
    // The API returns all stores within 50 miles of the zipcode
    // Store filtering must be done client-side after receiving results

    if (process.env.NODE_ENV === 'development') {
      // Redact API key for security - never log credentials
      const paramsForLogging = { ...params, api_key: '[REDACTED]' };
      const url = `${BASE_URL}?${new URLSearchParams(
        paramsForLogging,
      ).toString()}`;
      console.log(`[Target API] Checking stock for TCIN ${tcin} in ${zipCode}`);
      console.log(`[Target API] URL: ${url}`);
    }

    const response = await axiosInstance.get<TargetStoreStockResponse>('', {
      params,
      timeout: options?.timeout || DEFAULT_TIMEOUT,
    });

    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[Target API Response] TCIN ${tcin} - RAW RESPONSE:`,
        JSON.stringify(response.data, null, 2),
      );
    }

    // Cache the result (without storeId since API returns same data regardless)
    const cacheKey = generateProductStockCacheKey(zipCode, tcin);
    setCachedValue(stockCache, cacheKey, response.data);

    return response.data;
  } catch (error) {
    throw handleApiError(error, `TCIN ${tcin}`);
  }
}

/**
 * Check store stock for multiple TCINs concurrently
 * Target API doesn't support bulk requests, so we use Promise.all for concurrency
 *
 * @param tcins - Array of TCINs to check
 * @param zipCode - ZIP code for location
 * @param storeId - Optional store ID
 * @param options - Request options
 * @returns Map of TCIN to stock response
 *
 * @example
 * const stocks = await checkBulkStoreStock(['12345', '67890'], '04457');
 * stocks.forEach((stock, tcin) => {
 *   console.log(`${tcin}: ${stock.store_stock_results?.[0]?.in_stock}`);
 * });
 */
export async function checkBulkStoreStock(
  tcins: string[],
  zipCode: string,
  _storeId?: string,
  options?: ApiRequestOptions,
): Promise<Map<string, TargetStoreStockResponse>> {
  if (process.env.NODE_ENV === 'development') {
    console.log(
      `[Target API] Checking bulk stock for ${tcins.length} products`,
    );
  }

  // Create concurrent requests for all TCINs
  const stockPromises = tcins.map(async (tcin) => {
    try {
      const stock = await checkStoreStock(tcin, zipCode, _storeId, options);
      return { tcin, stock, error: null };
    } catch (error) {
      // Don't fail entire batch on individual errors
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[Target API] Failed to check stock for ${tcin}:`, error);
      }
      return { tcin, stock: null, error: error as ApiError };
    }
  });

  // Execute all requests concurrently
  const results = await Promise.all(stockPromises);

  // Build result map
  const stockMap = new Map<string, TargetStoreStockResponse>();
  results.forEach(({ tcin, stock }) => {
    if (stock) {
      stockMap.set(tcin, stock);
      // Also store as string and number for flexible lookup
      stockMap.set(tcin.toString(), stock);
      if (!isNaN(Number(tcin))) {
        stockMap.set(Number(tcin).toString(), stock);
      }
    }
  });

  return stockMap;
}

// ============================================================================
// Product Information API
// ============================================================================

/**
 * Get product details by TCIN
 * Uses type=product endpoint
 *
 * @param tcin - Target TCIN
 * @param options - Request options
 * @returns Product response
 * @throws ApiError if request fails
 *
 * @example
 * const product = await getProductByTcin('78025470');
 * console.log(product.Product?.Title);
 * console.log(product.Product?.Price?.value);
 */
export async function getProductByTcin(
  tcin: string,
  options?: ApiRequestOptions,
): Promise<TargetProductResponse> {
  // Check cache first
  if (!options?.skipCache) {
    const cacheKey = generateProductCacheKey(tcin);
    const cached = getCachedValue<TargetProductResponse>(
      productCache,
      cacheKey,
    );
    if (cached) {
      return cached;
    }
  }

  try {
    const params = {
      api_key: API_KEY,
      type: 'product',
      tcin,
    };

    if (process.env.NODE_ENV === 'development') {
      console.log(`[Target API] Fetching product details for TCIN ${tcin}`);
    }

    const response = await axiosInstance.get<TargetProductResponse>('', {
      params,
      timeout: options?.timeout || DEFAULT_TIMEOUT,
    });

    // Cache the result (1 hour TTL)
    const cacheKey = generateProductCacheKey(tcin);
    setCachedValue(productCache, cacheKey, response.data);

    return response.data;
  } catch (error) {
    throw handleApiError(error, `TCIN ${tcin}`);
  }
}

/**
 * Get multiple products concurrently
 *
 * @param tcins - Array of TCINs
 * @param options - Request options
 * @returns Map of TCIN to product response
 */
export async function getBulkProducts(
  tcins: string[],
  options?: ApiRequestOptions,
): Promise<Map<string, TargetProductResponse>> {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[Target API] Fetching ${tcins.length} product details`);
  }

  const productPromises = tcins.map(async (tcin) => {
    try {
      const product = await getProductByTcin(tcin, options);
      return { tcin, product, error: null };
    } catch (error) {
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[Target API] Failed to fetch product ${tcin}:`, error);
      }
      return { tcin, product: null, error: error as ApiError };
    }
  });

  const results = await Promise.all(productPromises);

  const productMap = new Map<string, TargetProductResponse>();
  results.forEach(({ tcin, product }) => {
    if (product) {
      productMap.set(tcin, product);
      productMap.set(tcin.toString(), product);
      if (!isNaN(Number(tcin))) {
        productMap.set(Number(tcin).toString(), product);
      }
    }
  });

  return productMap;
}

/**
 * Get full product details by TCIN (extended version)
 * Returns complete product data including variants, specifications, etc.
 *
 * @function
 * @param {string} tcin - Target TCIN (8-digit product ID)
 * @param {ApiRequestOptions} [options] - Request options (skipCache, timeout)
 * @returns {Promise<TargetProductFullResponse>} Full product response with extended details
 * @throws {ApiError} If request fails or product not found
 */
export async function getFullProductByTcin(
  tcin: string,
  options?: ApiRequestOptions,
): Promise<TargetProductFullResponse> {
  // Check cache first
  if (!options?.skipCache) {
    const cacheKey = `full_product_${tcin}`;
    const cached = getCachedValue<TargetProductFullResponse>(
      productCache,
      cacheKey,
    );
    if (cached) {
      return cached;
    }
  }

  try {
    const params = {
      api_key: API_KEY,
      type: 'product',
      tcin,
    };

    if (process.env.NODE_ENV === 'development') {
      console.log(
        `[Target API] Fetching full product details for TCIN ${tcin}`,
      );
    }

    const response = await axiosInstance.get<TargetProductFullResponse>('', {
      params,
      timeout: options?.timeout || DEFAULT_TIMEOUT,
    });

    // Cache the result (1 hour TTL)
    const cacheKey = `full_product_${tcin}`;
    setCachedValue(productCache, cacheKey, response.data);

    return response.data;
  } catch (error) {
    throw handleApiError(error, `TCIN ${tcin}`);
  }
}

/**
 * Get product details by UPC/GTIN barcode
 * Converts UPC to Target TCIN and retrieves product information
 *
 * @function
 * @param {string} gtin - UPC/GTIN barcode
 * @param {ApiRequestOptions} [options] - Request options
 * @returns {Promise<TargetProductFullResponse>} Product response
 * @throws {ApiError} If request fails or product not found
 *
 * @example
 * const product = await getProductByGtin('123456789012');
 * console.log(product.Product?.Title);
 * console.log(product.Product?.Tcin);
 */
export async function getProductByGtin(
  gtin: string,
  options?: ApiRequestOptions,
): Promise<TargetProductFullResponse> {
  // Check cache first
  if (!options?.skipCache) {
    const cacheKey = `product_gtin_${gtin}`;
    const cached = getCachedValue<TargetProductFullResponse>(
      productCache,
      cacheKey,
    );
    if (cached) {
      return cached;
    }
  }

  try {
    const params = {
      api_key: API_KEY,
      type: 'product',
      gtin,
    };

    if (process.env.NODE_ENV === 'development') {
      console.log(`[Target API] Fetching product by GTIN ${gtin}`);
    }

    const response = await axiosInstance.get<TargetProductFullResponse>('', {
      params,
      timeout: options?.timeout || DEFAULT_TIMEOUT,
    });

    // Cache the result (1 hour TTL)
    const cacheKey = `product_gtin_${gtin}`;
    setCachedValue(productCache, cacheKey, response.data);

    return response.data;
  } catch (error) {
    throw handleApiError(error, `GTIN ${gtin}`);
  }
}

// ============================================================================
// Product Search API
// ============================================================================

/**
 * Search for products on Target
 * Uses type=search endpoint
 *
 * @function
 * @param {string} searchTerm - Search keyword(s)
 * @param {Object} [options] - Search options
 * @param {number} [options.page] - Page number (default: 1)
 * @param {string} [options.sortBy] - Sort order (e.g., 'best_seller', 'price_low_to_high')
 * @param {boolean} [options.skipCache] - Skip cache lookup
 * @param {number} [options.timeout] - Request timeout
 * @returns {Promise<TargetSearchResponse>} Search results with products, pagination, and facets
 * @throws {ApiError} If request fails
 *
 * @example
 * const results = await searchProducts('highlighter pens', { page: 1 });
 * console.log(`Found ${results.pagination?.total_results} results`);
 * results.search_results?.forEach(item => {
 *   console.log(`${item.product.title} - $${item.offers.primary.price}`);
 * });
 */
export async function searchProducts(
  searchTerm: string,
  options?: ApiRequestOptions & { page?: number; sortBy?: string },
): Promise<TargetSearchResponse> {
  const page = options?.page || 1;

  // Check cache first
  if (!options?.skipCache) {
    const cacheKey = `search_${searchTerm}_page${page}_${
      options?.sortBy || 'default'
    }`;
    const cached = getCachedValue<TargetSearchResponse>(productCache, cacheKey);
    if (cached) {
      return cached;
    }
  }

  try {
    const params: Record<string, string> = {
      api_key: API_KEY,
      type: 'search',
      search_term: searchTerm,
      page: page.toString(),
    };

    if (options?.sortBy) {
      params.sort_by = options.sortBy;
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`[Target API] Searching for "${searchTerm}" (page ${page})`);
    }

    const response = await axiosInstance.get<TargetSearchResponse>('', {
      params,
      timeout: options?.timeout || DEFAULT_TIMEOUT,
    });

    // Cache the result (5 minutes TTL for search results)
    const cacheKey = `search_${searchTerm}_page${page}_${
      options?.sortBy || 'default'
    }`;
    setCachedValue(productCache, cacheKey, response.data);

    return response.data;
  } catch (error) {
    throw handleApiError(error, `Search: ${searchTerm}`);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract TCIN from Target product URL
 *
 * @param url - Target product URL
 * @returns TCIN or null if not found
 *
 * @example
 * extractTcinFromUrl('https://www.target.com/p/product-name/-/A-78025470')
 * // Returns: '78025470'
 */
export function extractTcinFromUrl(url: string): string | null {
  const match = url.match(/\/A-(\d{8})/);
  return match ? match[1] : null;
}

/**
 * Generate Target product page URL
 *
 * @param tcin - Target TCIN
 * @returns Product page URL
 *
 * @example
 * generateProductUrl('78025470')
 * // Returns: 'https://www.target.com/p/-/A-78025470'
 */
export function generateProductUrl(tcin: string): string {
  return `https://www.target.com/p/-/A-${tcin}`;
}

/**
 * Validate TCIN format (8-10 digits)
 *
 * @param tcin - TCIN to validate
 * @returns True if valid
 */
export function isValidTcin(tcin: string): boolean {
  return /^\d{8,10}$/.test(tcin);
}

// ============================================================================
// API Health Check
// ============================================================================

/**
 * Check if Target API is accessible
 *
 * @returns True if API is healthy
 */
export async function checkApiHealth(): Promise<boolean> {
  try {
    // Try to fetch a well-known product
    await getProductByTcin('78025470', { skipCache: true });
    return true;
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[Target API] Health check failed:', error);
    }
    return false;
  }
}
