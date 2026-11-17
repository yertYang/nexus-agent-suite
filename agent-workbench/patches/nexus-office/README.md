# Nexus Runner test source projections

This patch targets the Nexus revision pinned in `LOCK.json`. Workbench's `prepare:nexus` verifies both reviewed source files and applies the patch to staged Runner/Server before building. No dependency downloads are added. An existing Runner must restart to load the rebuilt code.

The new projection runs only after the original `file.read` trust policy, approval, canonical project-path resolution and regular-file check. The response retains the SHA-256 hash of the original ZIP bytes. Excel outputs sheet/cell references, Word outputs paragraph and table coordinates. Only UTF-8 OOXML parts are parsed; macros, encrypted archives, DTDs, external references and oversized inputs cannot be expanded or executed. Formula source isn't executed; displayed values are workbook caches.

Boundaries: 8 MiB archive, 400 ZIP entries, 32 MiB aggregate expansion, 8 MiB per part; text projection is capped at 2,000 entries and 500,000 characters. `sourceTruncated` prevents approving a partial test definition. Legacy `.doc`/`.xls` are not supported. Other binary files still use the original rejection path.
