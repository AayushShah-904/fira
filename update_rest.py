import os
import re

directories = [
    r'd:\Computer\Workspace\Projects\fira-project\docs\about',
    r'd:\Computer\Workspace\Projects\fira-project\docs\agent'
]

replacements = [
    (re.compile(r'bofia', re.IGNORECASE), 'fira')
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
                
                # Manual fix for the naming note paragraph in deployment.md if it got mangled
                if 'deployment.md' in path:
                    content = re.sub(
                        r'\*\*Important naming note:\*\*.*?(?:Terraform/Bicep state considers them locked\.|drift to fix\.)',
                        '**Important naming note:** the project was historically called \'Bank Interest Rate Discovery\' (BIRD), then renamed to \'Fixed Interest Rate Aggregator\' (FIRA). The Azure resources now carry the fira prefix. Do not attempt to rename them; Terraform/Bicep state considers them locked.',
                        content,
                        flags=re.DOTALL
                    )
                
                if content != original_content:
                    with open(path, 'w', encoding='utf-8') as file:
                        file.write(content)
                    print(f'Updated {path}')
                    count += 1

print(f'Total files updated: {count}')
