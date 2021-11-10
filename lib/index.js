"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.raw = exports.transform = void 0;
const loader_utils_1 = require("loader-utils");
const schema_utils_1 = require("schema-utils");
const schema = require("./schema.json");
const utils_1 = require("./utils");
const cache_1 = require("./cache");
const cloudinary = require("cloudinary");
const path = require("path");
const DEFAULTS = {
    quality: 85,
    placeholder: false,
    placeholderSize: 40,
    name: '[hash]-[width].[ext]',
    steps: 4,
    esModule: false,
    emitFile: true,
    rotate: 0,
    cacheDirectory: false,
    cacheCompression: true,
    cacheIdentifier: '',
    cloudinaryCredentials: undefined,
};
/**
 * **Responsive Loader**
 *
 * Creates multiple images from one source image, and returns a srcset
 * [Responsive Loader](https://github.com/dazuaz/responsive-loader)
 *
 * @param {Buffer} content Source
 *
 * @return {loaderCallback} loaderCallback Result
 */
function loader(content) {
    const loaderCallback = this.async();
    if (typeof loaderCallback == 'undefined') {
        new Error('Responsive loader callback error');
        return;
    }
    // Object representation of the query string
    const parsedResourceQuery = this.resourceQuery ? loader_utils_1.parseQuery(this.resourceQuery) : {};
    // Combines defaults, webpack options and query options,
    // later sources' properties overwrite earlier ones.
    const options = Object.assign({}, DEFAULTS, loader_utils_1.getOptions(this), parsedResourceQuery);
    // @ts-ignore
    schema_utils_1.validate(schema, options, { name: 'Responsive Loader' });
    /**
     * Parses options and set defaults options
     */
    const { outputContext, mime, ext, name, sizes, cloudinaryCredentials, outputPlaceholder, placeholderSize, imageOptions, cacheOptions, } = utils_1.parseOptions(this, options);
    if (!mime) {
        loaderCallback(new Error('No mime type for file with extension ' + ext + ' supported'));
        return;
    }
    const createFile = ({ data, width, height }) => {
        const fileName = loader_utils_1.interpolateName(this, name, {
            context: outputContext,
            content: data,
        })
            .replace(/\[width\]/gi, width + '')
            .replace(/\[height\]/gi, height + '');
        const { outputPath, publicPath } = utils_1.getOutputAndPublicPath(fileName, {
            outputPath: options.outputPath,
            publicPath: options.publicPath,
        });
        if (options.emitFile) {
            this.emitFile(outputPath, data, null);
        }
        return {
            src: publicPath + `+${JSON.stringify(` ${width}w`)}`,
            path: publicPath,
            width: width,
            height: height,
        };
    };
    /**
     * Disable processing of images by this loader (useful in development)
     */
    if (options.disable) {
        const { path } = createFile({ data: content, width: 100, height: 100 });
        loaderCallback(null, `${options.esModule ? 'export default' : 'module.exports ='} {
        srcSet: ${path},
        images: [{path:${path},width:100,height:100}],
        src: ${path},
        toString: function(){return ${path}}
      };`);
        return;
    }
    /**
     * The full config is passed to the adapter, later sources' properties overwrite earlier ones.
     */
    const adapterOptions = Object.assign({}, options, imageOptions);
    const transformParams = {
        adapterModule: options.adapter,
        resourcePath: this.resourcePath,
        adapterOptions,
        createFile,
        outputPlaceholder,
        placeholderSize,
        mime,
        sizes,
        esModule: options.esModule,
        cloudinaryCredentials: cloudinaryCredentials,
    };
    orchestrate({ cacheOptions, transformParams })
        .then((result) => loaderCallback(null, result))
        .catch((err) => loaderCallback(err));
}
exports.default = loader;
async function orchestrate(params) {
    // use cached, or create new image.
    let result;
    const { transformParams, cacheOptions } = params;
    if (cacheOptions.cacheDirectory) {
        result = await cache_1.cache(cacheOptions, transformParams);
    }
    else {
        result = await transform(transformParams);
    }
    return result;
}
class CloudinaryUploadError extends Error {
}
// Transform based on the parameters
async function transform({ adapterModule, createFile, resourcePath, sizes, mime, outputPlaceholder, placeholderSize, adapterOptions, esModule, cloudinaryCredentials, }) {
    const adapter = adapterModule || require('./adapters/jimp');
    const img = adapter(resourcePath);
    const results = await transformations({ img, sizes, mime, outputPlaceholder, placeholderSize, adapterOptions });
    let cloudinaryUrl;
    if (cloudinaryCredentials) {
        Object.entries(cloudinaryCredentials).forEach(entry => {
            if (entry[1] == undefined) {
                throw new CloudinaryUploadError(`Missing required cloudinary credential ${entry[0]}`);
            }
        });
        cloudinary.v2.config(cloudinaryCredentials);
        const resourceName = path.parse(resourcePath).name;
        const cloudinaryResults = await cloudinary.v2.uploader.upload(resourcePath, { public_id: resourceName, overwrite: true, invalidate: true }, (err) => {
            if (err)
                throw new CloudinaryUploadError(err.message);
        });
        cloudinaryUrl = cloudinaryResults.url.replace('/upload', '/upload/WIDTH');
    }
    if (cloudinaryUrl) {
        console.log(`Created image resource at ${cloudinaryUrl}`);
    }
    else {
        console.log(`Didn't upload ${path.parse(resourcePath).name} to cloudinary`);
    }
    let placeholder;
    let files;
    if (outputPlaceholder) {
        files = results.slice(0, -1).map(createFile);
        placeholder = utils_1.createPlaceholder(results[results.length - 1], mime);
    }
    else {
        files = results.map(createFile);
    }
    const srcset = files.map((f) => f.src).join('+","+');
    const images = files.map((f) => `{path: ${f.path},width: ${f.width},height: ${f.height}}`).join(',');
    const firstImage = files[0];
    const src = cloudinaryUrl ? `"${cloudinaryUrl}"` : firstImage.path;
    return `${esModule ? 'export default' : 'module.exports ='} {
        srcSet: ${srcset},
        images: [${images}],
        src: ${src},
        toString: function(){return ${firstImage.path}},
        ${placeholder ? 'placeholder: ' + placeholder + ',' : ''}
        width: ${firstImage.width},
        height: ${firstImage.height}
      }`;
}
exports.transform = transform;
/**
 * **Run Transformations**
 *
 * For each size defined in the parameters, resize an image via the adapter
 *
 */
async function transformations({ img, sizes, mime, outputPlaceholder, placeholderSize, adapterOptions, }) {
    const metadata = await img.metadata();
    const promises = [];
    const widthsToGenerate = new Set();
    sizes.forEach((size) => {
        const width = Math.min(metadata.width, size);
        // Only resize images if they aren't an exact copy of one already being resized...
        if (!widthsToGenerate.has(width)) {
            widthsToGenerate.add(width);
            promises.push(img.resize({
                width,
                mime,
                options: adapterOptions,
            }));
        }
    });
    if (outputPlaceholder) {
        promises.push(img.resize({
            width: placeholderSize,
            options: adapterOptions,
            mime,
        }));
    }
    return Promise.all(promises);
}
exports.raw = true;
