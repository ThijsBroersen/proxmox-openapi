#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Read and extract apiSchema from apidoc.js
function extractApiSchema(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Extract the apiSchema array from the JavaScript file
    // Find the const apiSchema = [ ... ] part
    // We need to find the opening bracket and then match until the closing bracket
    const startMatch = content.match(/const apiSchema = \[/);
    if (!startMatch) {
        throw new Error('Could not find apiSchema declaration in apidoc.js');
    }
    
    const startPos = startMatch.index + startMatch[0].length;
    let bracketCount = 1;
    let pos = startPos;
    
    // Find the matching closing bracket
    while (pos < content.length && bracketCount > 0) {
        if (content[pos] === '[') bracketCount++;
        else if (content[pos] === ']') bracketCount--;
        pos++;
    }
    
    if (bracketCount !== 0) {
        throw new Error('Could not find matching closing bracket for apiSchema');
    }
    
    const jsonContent = content.substring(startPos - 1, pos);
    
    // Parse the JSON array
    return JSON.parse(jsonContent);
}

// Convert Proxmox type to OpenAPI type
function convertType(proxmoxType) {
    const typeMap = {
        'string': 'string',
        'integer': 'integer',
        'number': 'number',
        'boolean': 'boolean',
        'array': 'array',
        'object': 'object',
        'null': 'null'
    };
    return typeMap[proxmoxType] || 'string';
}

// Convert Proxmox parameter to OpenAPI parameter/schema
function convertParameter(param, paramName, isPathParam = false) {
    const schema = {
        type: convertType(param.type)
    };
    
    if (param.description) {
        schema.description = param.description;
    }
    
    if (param.format) {
        schema.format = param.format;
    }
    
    if (param.pattern) {
        schema.pattern = param.pattern;
    }
    
    if (param.enum) {
        schema.enum = param.enum;
    }
    
    if (param.minimum !== undefined) {
        schema.minimum = param.minimum;
    }
    
    if (param.maximum !== undefined) {
        schema.maximum = param.maximum;
    }
    
    if (param.minLength !== undefined) {
        schema.minLength = param.minLength;
    }
    
    if (param.maxLength !== undefined) {
        schema.maxLength = param.maxLength;
    }
    
    if (param.default !== undefined) {
        schema.default = param.default;
    }
    
    if (param.items) {
        schema.items = convertParameter(param.items, 'item');
    }
    
    if (param.properties) {
        schema.properties = {};
        schema.required = [];
        for (const [propName, prop] of Object.entries(param.properties)) {
            schema.properties[propName] = convertParameter(prop, propName);
            if (!prop.optional && prop.optional !== 0) {
                schema.required.push(propName);
            }
        }
    }
    
    if (isPathParam) {
        // Remove description from schema for path parameters (it's in the parameter itself)
        const pathSchema = { ...schema };
        delete pathSchema.description;
        return {
            name: paramName,
            in: 'path',
            required: true,
            description: param.description || '',
            schema: pathSchema
        };
    }
    
    return schema;
}

// Convert Proxmox return type to OpenAPI response
function convertReturns(returns) {
    if (!returns || returns.type === 'null') {
        return {
            '200': {
                description: 'Success'
            }
        };
    }
    
    const schema = {
        type: convertType(returns.type)
    };
    
    if (returns.items) {
        schema.items = convertParameter(returns.items, 'item');
    }
    
    if (returns.properties) {
        schema.properties = {};
        schema.required = [];
        for (const [propName, prop] of Object.entries(returns.properties)) {
            schema.properties[propName] = convertParameter(prop, propName);
            if (!prop.optional && prop.optional !== 0) {
                schema.required.push(propName);
            }
        }
    }
    
    if (returns.links) {
        // Handle links if needed
    }
    
    return {
        '200': {
            description: 'Success',
            content: {
                'application/json': {
                    schema: schema
                }
            }
        }
    };
}

// Convert Proxmox operation to OpenAPI operation
function convertOperation(method, operation, pathParams) {
    const openapiOp = {
        summary: operation.description || operation.name,
        description: operation.description || '',
        operationId: operation.name || `${method.toLowerCase()}_${operation.path || 'unknown'}`.replace(/[^a-z0-9_]/g, '_'),
        tags: []
    };
    
    // Extract tags from path (e.g., /cluster/replication -> ['cluster'])
    if (operation.path) {
        const pathParts = operation.path.split('/').filter(p => p && !p.startsWith('{'));
        if (pathParts.length > 0) {
            openapiOp.tags = [pathParts[0]];
        }
    }
    
    // Handle parameters
    const parameters = [];
    
    // Add path parameters
    if (pathParams) {
        for (const [paramName, param] of Object.entries(pathParams)) {
            parameters.push(convertParameter(param, paramName, true));
        }
    }
    
    // Add query/body parameters
    if (operation.parameters) {
        if (operation.parameters.properties) {
            for (const [paramName, param] of Object.entries(operation.parameters.properties)) {
                // Check if it's a path parameter (already in path)
                const isPathParam = operation.path && operation.path.includes(`{${paramName}}`);
                
                if (isPathParam) {
                    // Already added as path parameter
                    continue;
                }
                
                // For GET/DELETE, parameters go in query
                // For POST/PUT, parameters go in requestBody
                if (['GET', 'DELETE'].includes(method)) {
                    parameters.push({
                        name: paramName,
                        in: 'query',
                        required: !param.optional,
                        description: param.description || '',
                        schema: convertParameter(param, paramName)
                    });
                }
            }
        }
    }
    
    if (parameters.length > 0) {
        openapiOp.parameters = parameters;
    }
    
    // Handle request body for POST/PUT
    if (['POST', 'PUT'].includes(method) && operation.parameters && operation.parameters.properties) {
        const bodyParams = {};
        const required = [];
        
        for (const [paramName, param] of Object.entries(operation.parameters.properties)) {
            // Skip path parameters
            if (operation.path && operation.path.includes(`{${paramName}}`)) {
                continue;
            }
            
            bodyParams[paramName] = convertParameter(param, paramName);
            if (!param.optional && param.optional !== 0) {
                required.push(paramName);
            }
        }
        
        if (Object.keys(bodyParams).length > 0) {
            openapiOp.requestBody = {
                required: true,
                content: {
                    'application/json': {
                        schema: {
                            type: 'object',
                            properties: bodyParams,
                            required: required.length > 0 ? required : undefined
                        }
                    }
                }
            };
        }
    }
    
    // Handle responses
    openapiOp.responses = convertReturns(operation.returns);
    
    // Add security if protected
    if (operation.protected) {
        openapiOp.security = [{ 'ProxmoxAuth': [] }];
    }
    
    return openapiOp;
}

// Extract path parameters from path string and operation parameters
function extractPathParams(path, operation) {
    const params = {};
    const matches = path.matchAll(/\{([^}]+)\}/g);
    
    for (const match of matches) {
        const paramName = match[1];
        // Try to find the parameter definition in the operation
        let paramDef = {
            type: 'string',
            description: `Path parameter: ${paramName}`
        };
        
        if (operation && operation.parameters && operation.parameters.properties && operation.parameters.properties[paramName]) {
            paramDef = operation.parameters.properties[paramName];
        }
        
        params[paramName] = paramDef;
    }
    
    return params;
}

// Traverse the API schema tree and build OpenAPI paths
function traverseSchema(schema, paths = {}, basePath = '') {
    for (const node of schema) {
        const nodePath = node.path || basePath;
        
        if (node.info) {
            // This is an endpoint with operations
            if (!paths[nodePath]) {
                paths[nodePath] = {};
            }
            
            for (const [method, operation] of Object.entries(node.info)) {
                if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
                    operation.path = nodePath;
                    const pathParams = extractPathParams(nodePath, operation);
                    paths[nodePath][method.toLowerCase()] = convertOperation(method, operation, pathParams);
                }
            }
        }
        
        if (node.children && node.children.length > 0) {
            traverseSchema(node.children, paths, nodePath);
        }
    }
    
    return paths;
}

// Generate OpenAPI YAML
function generateOpenAPI(apiSchema) {
    const paths = traverseSchema(apiSchema);
    
    const openapi = {
        openapi: '3.1.1',
        info: {
            title: 'Proxmox VE API',
            description: 'Proxmox Virtual Environment API',
            version: '1.0.0',
            contact: {
                name: 'Proxmox',
                url: 'https://www.proxmox.com'
            }
        },
        servers: [
            {
                url: 'https://{host}:8006/api2/json',
                description: 'Proxmox VE Server',
                variables: {
                    host: {
                        default: 'localhost'
                        // Note: description is not supported in server variables by some validators
                    }
                }
            }
        ],
        paths: paths,
        components: {
            securitySchemes: {
                ProxmoxAuth: {
                    type: 'http',
                    scheme: 'basic',
                    description: 'Proxmox VE uses HTTP Basic Authentication. Provide username and password, or use API tokens in the format: username@realm!tokenid=tokensecret'
                }
            }
        }
    };
    
    return openapi;
}

// Validate OpenAPI specification
async function validateOpenAPI(openapiSpec, outputPath) {
    try {
        const SwaggerParser = require('@apidevtools/swagger-parser');
        
        console.log('Validating OpenAPI 3.1.1 specification...');
        
        // Validate from file path (more reliable than object validation)
        const api = await SwaggerParser.validate(outputPath, {
            validate: {
                spec: true,
                schema: true
            }
        });
        
        // Check the version
        if (api.openapi !== '3.1.1') {
            throw new Error(`Expected OpenAPI version 3.1.1, but found ${api.openapi}`);
        }
        
        console.log('✓ OpenAPI 3.1.1 specification is valid!');
        return true;
    } catch (error) {
        console.error('✗ Validation failed:');
        if (error.details) {
            console.error('Validation errors:');
            error.details.forEach((detail, index) => {
                console.error(`  ${index + 1}. ${detail.message}`);
                if (detail.path) {
                    console.error(`     Path: ${detail.path.join('.')}`);
                }
            });
        } else if (error.errors) {
            console.error('Validation errors:');
            error.errors.forEach((err, index) => {
                console.error(`  ${index + 1}. ${err.message || err}`);
                if (err.path) {
                    console.error(`     Path: ${err.path.join ? err.path.join('.') : err.path}`);
                }
            });
        } else {
            console.error(`  ${error.message}`);
        }
        throw error;
    }
}

// Main function
async function main() {
    const apidocPath = path.join(__dirname, 'apidoc.js');
    const outputPath = path.join(__dirname, 'openapi.yaml');
    
    console.log('Reading apidoc.js...');
    const apiSchema = extractApiSchema(apidocPath);
    
    console.log('Converting to OpenAPI format...');
    const openapi = generateOpenAPI(apiSchema);
    
    console.log('Writing openapi.yaml...');
    // Convert to YAML (we'll use a simple YAML stringifier or JSON for now)
    // For proper YAML, we'd need js-yaml, but let's use JSON first and suggest yaml package
    const yaml = require('yaml');
    const yamlString = yaml.stringify(openapi, {
        indent: 2,
        lineWidth: 0,
        simpleKeys: false,
        foldFlow: false
    });
    
    fs.writeFileSync(outputPath, yamlString, 'utf8');
    
    // Validate the generated OpenAPI spec
    await validateOpenAPI(openapi, outputPath);
    
    console.log(`Successfully generated ${outputPath}`);
    console.log(`Found ${Object.keys(openapi.paths).length} paths`);
}

// Check if yaml package is available, if not, use JSON
try {
    require.resolve('yaml');
    main().catch(error => {
        console.error('\nGeneration failed:', error.message);
        process.exit(1);
    });
} catch (e) {
    console.error('yaml package not found. Installing...');
    const { execSync } = require('child_process');
    try {
        execSync('npm install yaml', { stdio: 'inherit' });
        main().catch(error => {
            console.error('\nGeneration failed:', error.message);
            process.exit(1);
        });
    } catch (err) {
        console.error('Failed to install yaml package. Generating JSON instead...');
        // Fallback to JSON
        const apidocPath = path.join(__dirname, 'apidoc.js');
        const outputPath = path.join(__dirname, 'openapi.json');
        const apiSchema = extractApiSchema(apidocPath);
        const openapi = generateOpenAPI(apiSchema);
        fs.writeFileSync(outputPath, JSON.stringify(openapi, null, 2), 'utf8');
        console.log(`Generated ${outputPath} instead. Install 'yaml' package for YAML output.`);
    }
}

