#!/usr/bin/env python3
"""Compile bundled block-theme data without executing PHP.

The tiny expression reader accepts only string literals, concatenation, gettext,
HTML escaping, sprintf, and get_template_directory_uri from the supplied themes.
An unknown expression fails the import instead of being evaluated or dropped.
"""
from pathlib import Path
import argparse, hashlib, html, json, re, shutil

THEMES = ('twentytwentyfive', 'twentytwentyfour', 'twentytwentythree')

class StaticExpression:
    def __init__(self, text, theme):
        self.text, self.theme, self.pos, self.variables = text, theme, 0, {}
    def token(self):
        while self.pos < len(self.text):
            if self.text[self.pos].isspace(): self.pos += 1; continue
            if self.text.startswith('/*', self.pos):
                end = self.text.index('*/', self.pos + 2); self.pos = end + 2; continue
            break
        if self.pos == len(self.text): return ('eof', '')
        start = self.pos; c = self.text[self.pos]; self.pos += 1
        if c in "'\"":
            value = ''
            while self.pos < len(self.text):
                ch = self.text[self.pos]; self.pos += 1
                if ch == c: return ('string', value)
                if ch == '\\' and self.pos < len(self.text):
                    nxt = self.text[self.pos]
                    if nxt in ('\\', c): value += nxt; self.pos += 1; continue
                value += ch
            raise ValueError('Unterminated string')
        if c.isalpha() or c in '_$':
            while self.pos < len(self.text) and (self.text[self.pos].isalnum() or self.text[self.pos] == '_'): self.pos += 1
            return ('name', self.text[start:self.pos])
        if c in '().,;=': return (c, c)
        raise ValueError('Unsupported token at ' + self.text[start:start+80])
    def peek(self):
        pos=self.pos; t=self.token(); self.pos=pos; return t
    def take(self, kind):
        t=self.token()
        if t[0] != kind: raise ValueError('Expected '+kind+', got '+repr(t))
        return t[1]
    def expression(self):
        value=self.atom()
        while self.peek()[0] == '.': self.take('.'); value += self.atom()
        return value
    def atom(self):
        kind,value=self.token()
        if kind == 'string': return value
        if kind != 'name': raise ValueError('Expected string/function, got '+repr((kind,value)))
        if value.startswith('$'):
            if value not in self.variables: raise ValueError('Unknown variable '+value)
            return self.variables[value]
        self.take('('); args=[]
        while self.peek()[0] != ')':
            args.append(self.expression())
            if self.peek()[0] == ',': self.take(',')
            elif self.peek()[0] != ')': raise ValueError('Expected comma')
        self.take(')')
        if value == 'get_template_directory_uri' and not args: return '/vendor/wordpress/wp-content/themes/'+self.theme
        if value in ('__','_x','esc_html__','esc_html_x','esc_html_e','esc_attr__','esc_attr_x','esc_attr_e','esc_url','wp_kses_post'):
            result=args[0]
            if value.startswith(('esc_html','esc_attr')):
                # WordPress does not double encode existing character entities.
                result=html.escape(result, quote=True).replace('&#x27;','&#039;')
                result=re.sub(r'&amp;((?:#[0-9]+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]+);)',r'&\1',result)
            return result
        if value in ('sprintf','printf'):
            index=[0]
            def replacement(m):
                if m.group(0)=='%%': return '%'
                n=int(m.group(1))-1 if m.group(1) else index[0]
                if not m.group(1): index[0]+=1
                return args[n+1]
            return re.sub(r'%%|%(?:(\d+)\$)?s',replacement,args[0])
        raise ValueError('Unsupported function '+value)
    def render(self):
        output=[]
        while self.peek()[0] != 'eof':
            pos=self.pos; kind,name=self.token()
            if kind=='name' and name.startswith('$'):
                self.take('='); self.variables[name]=self.expression()
            elif kind=='name' and name=='echo': output.append(self.expression())
            else:
                self.pos=pos; output.append(self.expression())
            if self.peek()[0]==';': self.take(';')
            elif self.peek()[0]!='eof': raise ValueError('Expected semicolon')
        return ''.join(output)

def compile_pattern(source, theme):
    header=re.search(r'<\?php\s*/\*\*(.*?)\*/',source,re.S)
    metadata={}
    if not header: raise ValueError('Missing pattern header')
    for line in header.group(1).splitlines():
        match=re.match(r'\s*\*\s*([\w ]+):\s*(.*?)\s*$',line)
        if match: metadata[match.group(1).strip().lower()]=match.group(2)
    source=source[:header.start()]+source[header.end():]
    # The header belongs to the first PHP segment, whose closing marker remains.
    source=source.replace('?>','',1) if source.lstrip().startswith('?>') else source
    content=re.sub(r'<\?php(.*?)\?>',lambda m:StaticExpression(m.group(1),theme).render(),source,flags=re.S).strip()
    if '<?' in content or '?>' in content: raise ValueError('Untranslated PHP marker')
    return metadata,content

def localize(value, theme):
    if isinstance(value,str): return value.replace('file:./','/vendor/wordpress/wp-content/themes/'+theme+'/')
    if isinstance(value,list): return [localize(v,theme) for v in value]
    if isinstance(value,dict): return {k:localize(v,theme) for k,v in value.items()}
    return value

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('reference',type=Path);parser.add_argument('--output',type=Path,default=Path(__file__).with_name('bundled.json'));parser.add_argument('--public',type=Path,default=Path(__file__).resolve().parents[2]/'public');args=parser.parse_args()
    result=[]
    for theme in THEMES:
        directory=args.reference/theme; stylesheet=(directory/'style.css').read_text()
        field=lambda key:re.search(r'^'+key+r':\s*(.*)$',stylesheet,re.M).group(1).strip()
        data={'id':theme,'name':field('Theme Name'),'version':field('Version'),'description':field('Description'),'themeJSON':localize(json.loads((directory/'theme.json').read_text()),theme),'templates':[],'parts':[],'patterns':[],'variations':[],'sourceFiles':[]}
        for kind,folder in [('templates','templates'),('parts','parts'),('patterns','patterns')]:
            for source in sorted((directory/folder).glob('*')):
                if source.suffix not in ('.html','.php'):continue
                text=source.read_text();metadata={}
                if source.suffix=='.php':metadata,text=compile_pattern(text,theme)
                else:text=text.strip()
                slug=metadata.get('slug',source.stem).split('/')[-1]
                data[kind].append({'slug':slug,'title':metadata.get('title',slug.replace('-',' ').title()),'content':text,'description':metadata.get('description',''),'categories':[v.strip() for v in metadata.get('categories','').split(',') if v.strip()],'blockTypes':[v.strip() for v in metadata.get('block types','').split(',') if v.strip()],'inserter':metadata.get('inserter','yes')!='no','source':str(source.relative_to(directory)),'sourceHash':hashlib.sha256(source.read_bytes()).hexdigest()})
                data['sourceFiles'].append({'path':str(source.relative_to(directory)),'sha256':hashlib.sha256(source.read_bytes()).hexdigest()})
        for source in json.loads(Path(__file__).with_name('directory-patterns.json').read_text()):
            if source['theme'] == theme:
                data['patterns'].append({k:v for k,v in source.items() if k not in ('theme','retrievedAt','modifiedAt')})
                data['sourceFiles'].append({'path':source['source'],'sha256':source['sourceHash']})
        for source in sorted((directory/'styles').rglob('*.json')):
            value=localize(json.loads(source.read_text()),theme)
            data['variations'].append({'slug':str(source.relative_to(directory/'styles').with_suffix('')),'title':value.get('title',source.stem.replace('-',' ').title()),'type':'theme' if source.parent.name=='styles' else source.parent.name,'data':value})
        asset_dir=args.public/'vendor/wordpress/wp-content/themes'/theme
        asset_dir.mkdir(parents=True,exist_ok=True)
        shutil.copytree(directory/'assets',asset_dir/'assets',dirs_exist_ok=True)
        for source in directory.iterdir():
            if source.is_file() and (source.suffix in ('.css','.png','.txt','.md') or 'license' in source.name.lower()):shutil.copy2(source,asset_dir/source.name)
        # Preserve every font's own embedded attribution, including source fonts
        # whose package omitted a separate full-text license.
        font_records = next(t['fonts'] for t in json.loads(Path(__file__).with_name('font-attributions.json').read_text()) if t['theme'] == theme)
        (asset_dir/'FONT-NOTICES.txt').write_text('\n\n'.join(row['file']+'\n'+row['copyright']+'\n'+row['license']+'\n'+row['licenseURL'] for row in font_records)+'\n')
        for folder in {str(Path(row['file']).parent) for row in font_records}:
            directory_fonts = [row for row in font_records if str(Path(row['file']).parent) == folder]
            target = asset_dir/folder
            if not any(('license' in item.name.lower() and item.name != 'FONT-LICENSE.txt') or 'ofl' in item.name.lower() for item in target.iterdir() if item.is_file()):
                notices = '\n\n'.join(sorted({row['copyright'] for row in directory_fonts}))
                license_name = 'Apache-2.0.txt' if any('Apache' in row['license'] for row in directory_fonts) else 'OFL-1.1.txt'
                (target/'FONT-LICENSE.txt').write_text(notices+'\n\n'+(Path(__file__).parent/'licenses'/license_name).read_text())
        result.append(data)
        print(theme,len(data['templates']),len(data['parts']),len(data['patterns']),len(data['variations']))
    args.output.write_text(json.dumps(result,ensure_ascii=False,separators=(',',':'))+'\n')
    args.output.with_name('tokens.json').write_text(json.dumps([{k:t[k] for k in ('id','name','themeJSON','variations')} for t in result],ensure_ascii=False,separators=(',',':'))+'\n')
if __name__=='__main__':main()
