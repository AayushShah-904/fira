import os
import re

directories = [
    r'd:\Computer\Workspace\Projects\fira-project\docs\about',
    r'd:\Computer\Workspace\Projects\fira-project\docs\agent'
]

replacements = [
    (re.compile(r'\brate-discovery-agent\b'), 'fira-project'),
    (re.compile(r'\bBIRD_'), 'FIRA_'),
    (re.compile(r'\bBIRD\b'), 'FIRA'),
    (re.compile(r'\bBird\b'), 'Fira'),
    (re.compile(r'\bbird\b'), 'fira'),
    (re.compile(r'\bbofia\b'), 'fira'),
    (re.compile(r'\bBofia\b'), 'Fira'),
    (re.compile(r'\bBOFIA\b'), 'FIRA'),
    (re.compile(r'Bank Interest Rate Discovery'), 'Fixed Interest Rate Aggregator'),
    (re.compile(r'Fixed Income Advisor \(FIA\)'), 'Fixed Interest Rate Aggregator (FIRA)'),
    (re.compile(r'\bFIA\b'), 'FIRA'),
]

count = 0
for d in directories:
    for root, _, files in os.walk(d):
        for f in files:
            if f.endswith('.md'):
                path = os.path.join(root, f)
                with open(path, 'r', encoding='utf-8') as file:
                    content = file.read()
                
                original_content = content
                for regex, replacement in replacements:
                    content = regex.sub(replacement, content)
                
                if content != original_content:
                    with open(path, 'w', encoding='utf-8') as file:
                        file.write(content)
                    print(f'Updated {path}')
                    count += 1

print(f'Total files updated: {count}')
