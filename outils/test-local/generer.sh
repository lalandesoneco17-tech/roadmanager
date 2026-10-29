#!/bin/bash
# Fabrique outils/test-local/index.html a partir de index.html, branche sur le faux Supabase (aucun acces a la vraie base).
# Usage : bash outils/test-local/generer.sh  puis ouvrir http://localhost:8899/outils/test-local/ (serveur statique a la racine du projet).
set -e
cd "$(dirname "$0")/../.."
python3 - <<'PY'
import re
s=open('index.html',encoding='utf-8').read()
s=re.sub(r"window\.SUPABASE_URL='[^']*';","window.SUPABASE_URL='http://faux.local';",s)
s=re.sub(r"window\.SUPABASE_ANON_KEY='[^']*';","window.SUPABASE_ANON_KEY='faux';",s)
s=re.sub(r"try\{window\.supabaseClient=window\.supabase\.createClient\([^\n]*\n","window.supabaseClient=window.fauxSupabase;\n",s)
s=s.replace("<script>\n// Supabase client init","<script src=\"faux-supabase.js\"></script>\n<script>\n// Supabase client init (FAUX, test local)")
s=s.replace("var SRC='app.v6.jsx'","var SRC='../../app.v6.jsx'")
for f in ['icone.png','logo.png','icone-180.png','icone-192.png','icone-512.png','manifest.webmanifest']:
    s=s.replace('"'+f+'"','"../../'+f+'"').replace("'"+f+"'","'../../"+f+"'")
s=s.replace('<title>','<title>[TEST LOCAL] ',1)
open('outils/test-local/index.html','w',encoding='utf-8').write(s)
print('outils/test-local/index.html genere')
PY
