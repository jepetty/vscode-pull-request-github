/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const MarkdownIt = require('markdown-it');
const md = MarkdownIt({
	html: true
});

md.html = false;
export default md;
