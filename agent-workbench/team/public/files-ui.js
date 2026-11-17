// The page API always derives file ownership and sharing rights from the website session.
export async function filesPage(root, { api, button, el, card, form, onAction, render, notice }) {
  const upload = (id, file, version) => {
    const path = '/api/files/' + (id ? id + '/replace' : 'upload');
    if (!file || file.size > 2 * 1024 * 1024) throw Error('请选择不超过 2 MiB 的文件');
    return fetch(path, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/octet-stream',
        'x-navi-web': '1',
        'x-file-name': encodeURIComponent(file.name),
        'x-file-version': String(version || 0)
      },
      body: file
    }).then(async (r) => {
      if (!r.ok) throw Error((await r.json()).error);
    });
  };
  const picker = (box, title, onFile) => {
    const f = el('form'),
      l = el('label', title),
      i = el('input', null, 'nv-input');
    i.type = 'file';
    i.required = true;
    l.append(i);
    const b = el('button', title, 'nv-button');
    f.append(l, b);
    box.append(f);
    f.onsubmit = onAction(b, async () => {
      if (!i.files[0]) return;
      await onFile(i.files[0]);
      render();
    });
  };
  const c = card(root, '任务文件');
  c.append(
    el('p', '上传后仅自己可见。展开文件可共享给指定账号。接收方只能访问这一份文件，可编辑成员能上传新版本。')
  );
  picker(c, '上传私有文件（最多 2 MiB）', (f) => upload(null, f));
  const rows = await api('files');
  for (const [access, title] of [
    ['owner', '我的文件'],
    ['others', '共享给我']
  ]) {
    const d = card(root, title);
    const part = rows.filter((x) => (access === 'owner' ? x.access === 'owner' : x.access !== 'owner'));
    if (!part.length) d.append(el('p', '暂无文件。'));
    for (const x of part) {
      const item = el('details', null, 'item');
      d.append(item);
      item.append(
        el('summary', `${x.name} · v${x.version} · ${x.size} 字节`),
        el(
          'p',
          `所有者：${x.owner} · 最近修改：${x.editor} · ${x.access === 'owner' ? '本人所有' : x.access === 'read' ? '只读' : '可编辑'}`
        )
      );
      const a = el('a', '下载当前文件', 'nv-button');
      a.href = '/api/files/' + x.id + '/download';
      a.download = x.name;
      item.append(a);
      if (x.access !== 'read') picker(item, '上传替换版本', (f) => upload(x.id, f, x.version));
      if (x.access === 'owner') {
        const share = el('div');
        item.append(share);
        const paint = async () => {
          const rights = await api('files/' + x.id + '/grants');
          share.replaceChildren(el('h3', '共享给指定账号'));
          form(
            share,
            [
              ['name', '接收方用户名'],
              [
                'access',
                '访问权限',
                [
                  ['read', '只读'],
                  ['edit', '可编辑']
                ]
              ]
            ],
            '保存共享权限',
            async (body) => {
              await api('files/' + x.id + '/grants', body);
              await paint();
              notice('共享权限已保存。');
            }
          );
          for (const g of rights) {
            const r = el('div', null, 'row');
            r.append(
              el('span', g.name + ' · ' + (g.access === 'edit' ? '可编辑' : '只读')),
              button('撤销共享', async () => {
                await api('files/' + x.id + '/grants', { name: g.name, access: 'remove' });
                await paint();
              })
            );
            share.append(r);
          }
        };
        item.ontoggle = () => {
          if (item.open) paint().catch((e) => notice(e.message));
        };
        item.append(
          button('删除文件', async () => {
            if (confirm('永久删除 ' + x.name + ' 及其共享权限？')) {
              await api('files/' + x.id + '/delete', { version: x.version });
              render();
            }
          })
        );
      }
    }
  }
}
