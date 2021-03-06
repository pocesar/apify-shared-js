const { JsonVariable, jsonStringifyExtended } = require('./utilities.client');

class WebhookPayloadTemplateError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
        if (typeof Error.captureStackTrace === 'function') {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

export class InvalidJsonError extends WebhookPayloadTemplateError {
    constructor(originalError) {
        super(originalError.message);
    }
}
export class InvalidVariableError extends Error {
    constructor(variable) {
        super(`Invalid payload template variable: ${variable}`);
    }
}

/**
 * WebhookPayloadTemplate enables creation and parsing of webhook payload template strings.
 * Template strings are JSON that may include template variables enclosed in double
 * curly brackets: `{{variable}}`. When the template is parsed, variables are replaced
 * with values from a provided context.
 *
 * This is useful to create dynamic webhook payloads where a template is saved on webhook
 * creation and then variables are dynamically added on webhook dispatch.
 *
 * **Example:**
 * ```js
 * const payloadTemplate = `{
 *    "id": "some-id",
 *    "createdAt": "2019-05-08T15:22:21.095Z",
 *    "dataToSend": {{data}}
 * }`
 *
 * const data = {
 *     status: 200,
 *     body: 'hello world'
 * }
 *
 * const payloadObject = WebhookPayloadTemplate.parse(payloadTemplate, null, { data })
 * ```
 *
 * **Produces:**
 * ```js
 * {
 *     id: "some-id",
 *    createdAt: '2019-05-08T15:22:21.095Z',
 *    dataToSend: {
 *        status: 200,
 *        body: 'hello world'
 *    }
 * }
 * ```
 * @hideconstructor
 */
export default class WebhookPayloadTemplate {
    constructor(payloadTemplate, allowedVariables = null, context = {}) {
        this.template = payloadTemplate;
        this.allowedVariables = allowedVariables;
        this.context = context;

        this.payload = this.template;
        this.replacedVariables = [];
    }

    /**
     * Parse existing webhook payload template string into an object, replacing
     * template variables using the provided context.
     *
     * Parse also validates the template structure, so it can be used
     * to check validity of the template JSON and usage of allowedVariables.
     * @param {string} payloadTemplate
     * @param {Set<string>|null} [allowedVariables=null]
     * @param {Object} [context={}]
     * @return {object}
     */
    static parse(payloadTemplate, allowedVariables, context) {
        const type = typeof payloadTemplate;
        if (type !== 'string') throw new Error(`Cannot parse a ${type} payload template.`);
        const template = new WebhookPayloadTemplate(payloadTemplate, allowedVariables, context);
        return template._parse(); // eslint-disable-line no-underscore-dangle
    }

    /**
     * Stringify an object into a webhook payload template.
     * Values created using `getTemplateVariable('foo.bar')`
     * will be stringified to `{{foo.bar}}` template variable.
     * @param {Object} objectTemplate
     * @param {Function} [replacer]
     * @param {number} [indent=2]
     * @return {string}
     */
    static stringify(objectTemplate, replacer, indent = 2) {
        const type = typeof objectTemplate;
        if (!objectTemplate || type !== 'object') throw new Error(`Cannot stringify a ${type} payload template.`);
        return jsonStringifyExtended(objectTemplate, replacer, indent);
    }

    /**
     * Produces an instance of a template variable that can be used
     * in objects and will be stringified into `{{variableName}}` syntax.
     *
     * **Example:**
     * ```js
     * const resourceVariable = WebhookPayloadTemplate.getVariable('resource');
     * const objectTemplate = {
     *     foo: 'foo',
     *     bar: ['bar'],
     *     res: resourceVariable,
     * }
     *
     * const payloadTemplate = WebhookPayloadTemplate.stringify(objectTemplate);
     * ```
     *
     * **Produces:**
     * ```json
     * {
     *     "foo": "foo",
     *     "bar": ["bar"],
     *     "res": {{resource}},
     * }
     * ```
     *
     * @param {string} variableName
     * @return {JsonVariable}
     */
    static getVariable(variableName) {
        return new JsonVariable(variableName);
    }

    /** @private */
    _parse() {
        while (true) {
            // eslint-disable-line no-constant-condition
            try {
                return JSON.parse(this.payload);
            } catch (err) {
                const position = this._findPositionOfNextVariable();
                if (position) {
                    this._replaceVariable(position);
                } else {
                    // When we catch an error from JSON.parse, but there's
                    // no variable, we must have an invalid JSON.
                    throw new InvalidJsonError(err);
                }
            }
        }
    }

    /** @private */
    _findPositionOfNextVariable(startIndex) {
        const openBraceIndex = this.payload.indexOf('{{', startIndex);
        const closeBraceIndex = this.payload.indexOf('}}', openBraceIndex) + 1;
        const someVariableMaybeExists = (openBraceIndex > -1) && (closeBraceIndex > -1);
        if (!someVariableMaybeExists) return null;
        const isInsideString = this._isVariableInsideString(openBraceIndex);
        if (!isInsideString) return { openBraceIndex, closeBraceIndex };
        return this._findPositionOfNextVariable(openBraceIndex + 1);
    }

    /** @private */
    _isVariableInsideString(openBraceIndex) {
        const unescapedQuoteCount = this._countUnescapedDoubleQuotesUpToIndex(openBraceIndex);
        return unescapedQuoteCount % 2 === 1;
    }

    /** @private */
    _countUnescapedDoubleQuotesUpToIndex(index) {
        const payloadSection = this.payload.substring(0, index);
        let unescapedQuoteCount = 0;
        for (let i = 0; i < payloadSection.length; i++) {
            const char = payloadSection[i];
            const prevChar = payloadSection[i - 1];
            if (char === '"' && prevChar !== '\\') {
                unescapedQuoteCount++;
            }
        }
        return unescapedQuoteCount;
    }

    /** @private */
    _replaceVariable({ openBraceIndex, closeBraceIndex }) {
        const variableName = this.payload.substring(openBraceIndex + 2, closeBraceIndex - 1);
        this._validateVariableName(variableName);
        const replacement = this._getVariableReplacement(variableName);
        this.replacedVariables.push({ variableName, replacement });
        this.payload = this.payload.replace(`{{${variableName}}}`, replacement);
    }

    /** @private */
    _validateVariableName(variableName) {
        if (this.allowedVariables === null) return;
        const [variable] = variableName.split('.');

        // Properties of the variable are not validated on purpose
        // as they will later be set to null if not found.
        // This serves to enable dynamic variable structures.
        const isVariableValid = this.allowedVariables.has(variable);

        if (!isVariableValid) throw new InvalidVariableError(variableName);
    }

    /** @private */
    _getVariableReplacement(variableName) {
        const [variable, ...properties] = variableName.split('.');
        const context = this.context[variable];
        const replacement = properties.reduce((ctx, prop) => {
            if (!ctx || typeof ctx !== 'object') return null;
            return ctx[prop];
        }, context);
        return replacement ? JSON.stringify(replacement) : null;
    }
}
