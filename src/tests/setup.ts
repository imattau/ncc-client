import '@testing-library/jest-dom';
import { Buffer } from 'buffer';

// Polyfills for testing environment
global.Buffer = Buffer;
global.TextEncoder = require('util').TextEncoder;
global.TextDecoder = require('util').TextDecoder;
