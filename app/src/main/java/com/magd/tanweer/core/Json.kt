package com.magd.tanweer.core

import kotlinx.serialization.json.Json

/**
 * العقد مع الخادم: camelCase، وحقول اختيارية كثيرة.
 * `ignoreUnknownKeys` يجعل التطبيق القديم لا ينكسر حين يضيف الخادم حقلًا جديدًا،
 * و`explicitNulls = false` يجعل الطلبات لا ترسل nulls زائدة.
 */
val TanweerJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = false
    encodeDefaults = true
}
