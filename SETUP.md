# RoadManager — Setup Supabase

## 1. Creer la table dans Supabase

1. Va sur https://supabase.com/dashboard
2. Selectionne ton projet `valtmsgqhrkvwjsdqfdc`
3. Va dans **SQL Editor** (menu gauche)
4. Clique **New Query**
5. Colle ce SQL et clique **Run** :

```sql
CREATE TABLE IF NOT EXISTS app_data (
  id TEXT PRIMARY KEY DEFAULT 'main',
  data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO app_data (id, data)
VALUES ('main', '{}')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all access" ON app_data
  FOR ALL
  USING (true)
  WITH CHECK (true);
```

## 2. Activer le temps reel

1. Va dans **Database** > **Replication**
2. Active la replication pour la table `app_data`

Ou execute ce SQL :

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE app_data;
```

## 3. Verifier

1. Ouvre l'app dans ton navigateur
2. Ouvre la console (F12) — tu devrais voir "Loaded from Supabase" ou "Migrated localStorage to Supabase"
3. Cree une donnee (ex: ajoute un employe)
4. Va dans Supabase Dashboard > Table Editor > app_data — tu devrais voir tes donnees dans la colonne "data"
5. Ouvre l'app dans un 2e onglet — les donnees sont les memes

## Migration automatique

Les donnees existantes dans localStorage sont automatiquement migrees vers Supabase au premier chargement.
localStorage reste en backup permanent — si Supabase est injoignable, l'app fonctionne quand meme.
