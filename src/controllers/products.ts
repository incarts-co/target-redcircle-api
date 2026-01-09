/**
 * @fileoverview Product information controllers
 * @description HTTP request handlers for product lookup and search endpoints
 * @module controllers/products
 * @related services/target/api.ts, types/index.ts
 */

import { Request, Response } from 'express';
import {
  getFullProductByTcin,
  getProductByGtin,
  searchProducts,
  isValidTcin,
} from '../services/target/api';
import { ValidationError } from '../types';

// ============================================================================
// Product Lookup by TCIN
// ============================================================================

/**
 * GET /api/products/:tcin
 * Get detailed product information by TCIN
 *
 * @function
 * @param {Request} req - Express request with TCIN parameter
 * @param {Response} res - Express response
 * @returns {Promise<void>}
 */
export async function getProductByTcin(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { tcin } = req.params;

    // Validate TCIN format
    if (!tcin || !isValidTcin(tcin)) {
      throw new ValidationError(
        'Invalid TCIN format. Must be 8-10 digits.',
        'tcin',
        { tcin },
      );
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`[Product Controller] Getting product details for TCIN: ${tcin}`);
    }

    // Fetch product from RedCircle API
    const productData = await getFullProductByTcin(tcin);

    // Check if product was found
    if (!productData.product) {
      res.status(404).json({
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: `Product with TCIN ${tcin} not found`,
        },
      });
      return;
    }

    // Return successful response
    res.json({
      success: true,
      data: productData.product,
      request_info: productData.request_info,
      request_metadata: productData.request_metadata,
      location_info: productData.location_info,
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[Product Controller] Error:', error);
    }

    if (error instanceof ValidationError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          field: error.field,
          details: error.details,
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'development'
          ? (error as Error).message
          : 'Failed to fetch product information',
      },
    });
  }
}

// ============================================================================
// Product Lookup by UPC/GTIN
// ============================================================================

/**
 * GET /api/products/upc/:gtin
 * Get product information by UPC/GTIN barcode
 *
 * @function
 * @param {Request} req - Express request with GTIN parameter
 * @param {Response} res - Express response
 * @returns {Promise<void>}
 */
export async function getProductByUpc(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { gtin } = req.params;

    // Validate GTIN/UPC format (typically 12-14 digits)
    if (!gtin || !/^\d{8,14}$/.test(gtin)) {
      throw new ValidationError(
        'Invalid UPC/GTIN format. Must be 8-14 digits.',
        'gtin',
        { gtin },
      );
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`[Product Controller] Getting product by UPC/GTIN: ${gtin}`);
    }

    // Fetch product from RedCircle API
    const productData = await getProductByGtin(gtin);

    // Check if product was found
    if (!productData.product) {
      res.status(404).json({
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: `Product with UPC/GTIN ${gtin} not found`,
        },
      });
      return;
    }

    // Return successful response
    res.json({
      success: true,
      data: productData.product,
      request_info: productData.request_info,
      request_metadata: productData.request_metadata,
      location_info: productData.location_info,
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[Product Controller] Error:', error);
    }

    if (error instanceof ValidationError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          field: error.field,
          details: error.details,
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'development'
          ? (error as Error).message
          : 'Failed to fetch product information',
      },
    });
  }
}

// ============================================================================
// Product Search
// ============================================================================

/**
 * GET /api/products/search?q={keyword}&page={page}&sort={sort}
 * Search for products on Target
 *
 * @function
 * @param {Request} req - Express request with query parameters
 * @param {Response} res - Express response
 * @returns {Promise<void>}
 */
export async function searchProductsHandler(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const {
      q: searchTerm,
      page: pageParam,
      sort: sortBy,
    } = req.query;

    // Validate search term
    if (!searchTerm || typeof searchTerm !== 'string' || searchTerm.trim().length === 0) {
      throw new ValidationError(
        'Search term is required and must not be empty',
        'q',
        { searchTerm },
      );
    }

    // Parse and validate page number
    const page = pageParam ? parseInt(pageParam as string, 10) : 1;
    if (Number.isNaN(page) || page < 1) {
      throw new ValidationError(
        'Page must be a positive integer',
        'page',
        { page: pageParam },
      );
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`[Product Controller] Searching for "${searchTerm}" (page ${page})`);
    }

    // Search products via RedCircle API
    const searchResults = await searchProducts(searchTerm.trim(), {
      page,
      sortBy: sortBy as string | undefined,
    });

    // Check if any results found
    if (!searchResults.search_results || searchResults.search_results.length === 0) {
      res.json({
        success: true,
        data: {
          results: [],
          pagination: {
            current_page: page,
            total_pages: 0,
            total_results: 0,
          },
          message: 'No products found matching your search',
        },
      });
      return;
    }

    // Return successful response
    res.json({
      success: true,
      data: {
        results: searchResults.search_results,
        pagination: searchResults.pagination,
        facets: searchResults.facets,
        categories: searchResults.categories,
        related_queries: searchResults.related_queries,
      },
      request_info: searchResults.request_info,
      request_metadata: searchResults.request_metadata,
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      console.error('[Product Controller] Error:', error);
    }

    if (error instanceof ValidationError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          field: error.field,
          details: error.details,
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: process.env.NODE_ENV === 'development'
          ? (error as Error).message
          : 'Failed to search products',
      },
    });
  }
}
